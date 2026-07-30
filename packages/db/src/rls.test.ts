/**
 * PORTÃO DE CI — isolamento de tenant.
 *
 * Doc 00, 5.4 · Doc 01, 17.3. Falha aqui bloqueia merge.
 *
 * Este arquivo não testa "o código filtra por cliente". Ele testa que o BANCO
 * recusa, mesmo que o código erre. Cada caso abaixo corresponde a uma forma real
 * de vazar dado entre clientes que passa despercebida em revisão.
 *
 * Requer Postgres. Sem DATABASE_URL_ADMIN, os testes são pulados — e o CI
 * trata "pulado" como falha (ver .github/workflows/ci.yml).
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import pg from 'pg'

import { comTenant, poolPortal } from './index.js'
import { migrate } from './migrate.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const SENHA = process.env['OPS_TEST_PASSWORD'] ?? 'teste_local_apenas'

const CONTA_A = '11111111-1111-1111-1111-111111111111'
const CONTA_B = '22222222-2222-2222-2222-222222222222'

function urlComoRole(admin: string, role: string): string {
  const u = new URL(admin)
  u.username = role
  u.password = SENHA
  return u.toString()
}

describe('isolamento de tenant em public_v', { skip: !ADMIN }, () => {
  let admin: pg.Client
  let portal: pg.Pool

  before(async () => {
    await migrate(ADMIN as string)

    admin = new pg.Client({ connectionString: ADMIN })
    await admin.connect()

    for (const role of ['ops_api', 'ops_portal', 'ops_worker']) {
      await admin.query(`ALTER ROLE ${role} WITH PASSWORD '${SENHA}'`)
    }

    await admin.query(
      `INSERT INTO core.account (id, razao_social, porte, setor)
       VALUES ($1, 'Cliente A', 'medio', 'industria'),
              ($2, 'Cliente B', 'medio', 'industria')
       ON CONFLICT (id) DO NOTHING`,
      [CONTA_A, CONTA_B],
    )

    await admin.query(
      `INSERT INTO public_v.metric_daily (account_id, competencia, metrica, valor, n_base)
       VALUES ($1, '2026-07-25', 'adesao_30d', 0.41, 820),
              ($1, '2026-06-25', 'adesao_30d', 0.38, 810),
              ($2, '2026-07-25', 'adesao_30d', 0.77, 210)
       ON CONFLICT DO NOTHING`,
      [CONTA_A, CONTA_B],
    )

    portal = poolPortal(urlComoRole(ADMIN as string, 'ops_portal'))
  })

  after(async () => {
    await portal?.end()
    await admin?.end()
  })

  // ── O caso central ────────────────────────────────────────────────────────

  test('o cliente A só enxerga as linhas do cliente A', async () => {
    const rows = await comTenant(portal, CONTA_A, async (c) => {
      const r = await c.query<{ account_id: string }>('SELECT account_id FROM public_v.metric_daily')
      return r.rows
    })
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => r.account_id === CONTA_A))
  })

  test('filtrar explicitamente pelo cliente B, com token de A, devolve vazio', async () => {
    // Simula o pior caso: o código aceitou um identificador de fora e o usou.
    // A política do banco ignora o pedido e a resposta é vazia — não é dado de B.
    const rows = await comTenant(portal, CONTA_A, async (c) => {
      const r = await c.query('SELECT * FROM public_v.metric_daily WHERE account_id = $1', [CONTA_B])
      return r.rows
    })
    assert.equal(rows.length, 0)
  })

  // ── Falha fechada ─────────────────────────────────────────────────────────

  test('consulta sem tenant definido devolve zero linhas, não a base toda', async () => {
    const client = await portal.connect()
    try {
      const r = await client.query('SELECT * FROM public_v.metric_daily')
      assert.equal(r.rows.length, 0)
    } finally {
      client.release()
    }
  })

  test('tenant vazio devolve zero linhas em vez de estourar', async () => {
    // `''::uuid` levantaria exceção e viraria 500. NULLIF em ops.current_tenant()
    // transforma isso em conjunto vazio.
    const client = await portal.connect()
    try {
      await client.query(`SELECT set_config('app.current_tenant', '', true)`)
      const r = await client.query('SELECT * FROM public_v.metric_daily')
      assert.equal(r.rows.length, 0)
    } finally {
      client.release()
    }
  })

  test('o tenant não vaza entre requisições que reusam a conexão do pool', async () => {
    // O vazamento real: set_config em nível de SESSÃO persiste na conexão.
    // Duas leituras seguidas no mesmo pool, a segunda sem definir tenant.
    const poolDeUm = poolPortal(urlComoRole(ADMIN as string, 'ops_portal'))
    try {
      await comTenant(poolDeUm, CONTA_B, async (c) => c.query('SELECT 1'))

      const client = await poolDeUm.connect()
      try {
        const r = await client.query('SELECT * FROM public_v.metric_daily')
        assert.equal(r.rows.length, 0, 'tenant da requisição anterior sobreviveu na conexão')
      } finally {
        client.release()
      }
    } finally {
      await poolDeUm.end()
    }
  })

  // ── Fronteira de esquema ──────────────────────────────────────────────────

  test('o portal não alcança esquema interno nenhum', async () => {
    const client = await portal.connect()
    try {
      for (const alvo of [
        'core.account',
        'fact.mrr_event',
        'metrics.daily_snapshot',
        'metrics.signal',
        'ops.audit',
      ]) {
        await assert.rejects(
          client.query(`SELECT * FROM ${alvo} LIMIT 1`),
          /permission denied|does not exist/i,
          `${alvo} alcançável pelo portal`,
        )
      }
    } finally {
      client.release()
    }
  })

  test('o portal não escreve em public_v', async () => {
    await assert.rejects(
      comTenant(portal, CONTA_A, async (c) =>
        c.query(
          `INSERT INTO public_v.metric_daily (account_id, competencia, metrica, valor)
           VALUES ($1, '2026-07-26', 'adesao_30d', 1)`,
          [CONTA_A],
        ),
      ),
      /permission denied/i,
    )
  })

  test('ops_portal tem USAGE em exatamente um esquema', async () => {
    // Invariante auditável: a superfície do cliente alcança public_v e nada mais.
    // Enunciada como teste porque é fácil de violar sem perceber — basta um GRANT
    // de conveniência numa migration futura para resolver um erro de permissão.
    const { rows } = await admin.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE has_schema_privilege('ops_portal', nspname, 'USAGE')
          AND nspname NOT LIKE 'pg\\_%'
          AND nspname <> 'information_schema'
        ORDER BY nspname`,
    )
    assert.deepEqual(
      rows.map((r) => r.nspname),
      ['public_v'],
      'ops_portal alcança esquema além de public_v',
    )
  })

  test('a superfície interna não alcança public_v', async () => {
    // Se o interno lesse a versão suprimida, o número mostrado ao CSM passaria a
    // depender do tamanho da base do cliente.
    const api = new pg.Client({ connectionString: urlComoRole(ADMIN as string, 'ops_api') })
    await api.connect()
    try {
      await assert.rejects(
        api.query('SELECT * FROM public_v.metric_daily LIMIT 1'),
        /permission denied|does not exist/i,
      )
    } finally {
      await api.end()
    }
  })

  // ── Invariantes de dado ───────────────────────────────────────────────────

  test('linha suprimida não pode carregar valor', async () => {
    await assert.rejects(
      admin.query(
        `INSERT INTO public_v.metric_daily (account_id, competencia, metrica, valor, suprimido)
         VALUES ($1, '2026-05-25', 'adesao_30d', 0.5, true)`,
        [CONTA_A],
      ),
      /suprimido_nao_tem_valor/,
    )
  })

  test('benchmark abaixo do k-anonimato é recusado pelo banco', async () => {
    await assert.rejects(
      admin.query(
        `INSERT INTO public_v.benchmark_monthly
           (competencia, porte, setor, metrica, p50, n_empresas, n_pessoas)
         VALUES ('2026-07-01', 'medio', 'industria', 'adesao_30d', 0.5, 2, 400)`,
      ),
      /benchmark_k_anonimato/,
      'grupo com 2 empresas foi aceito — uma deduz a outra',
    )
  })

  test('fact é append-only: UPDATE e DELETE são recusados', async () => {
    await admin.query(
      `INSERT INTO fact.mrr_event (account_id, competencia, valor_centavos, tipo, origem, chave_natural)
       VALUES ($1, '2026-07-01', 500000, 'novo', 'ops', 'teste-append-only')
       ON CONFLICT (chave_natural) DO NOTHING`,
      [CONTA_A],
    )
    await assert.rejects(
      admin.query(`UPDATE fact.mrr_event SET valor_centavos = 1 WHERE chave_natural = 'teste-append-only'`),
      /append-only/,
    )
    await assert.rejects(
      admin.query(`DELETE FROM fact.mrr_event WHERE chave_natural = 'teste-append-only'`),
      /append-only/,
    )
  })

  test('override de score exige autor, motivo e validade', async () => {
    await assert.rejects(
      admin.query(
        `INSERT INTO metrics.signal
           (competencia, account_id, faixa_por_regra, faixa_final, override_ativo)
         VALUES ('2026-07-25', $1, 'saudavel', 'critico', true)`,
        [CONTA_A],
      ),
      /override_exige_justificativa_e_validade/,
      'override sem validade viraria vermelho permanente',
    )
  })
})
