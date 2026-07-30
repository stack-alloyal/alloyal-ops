/**
 * As quatro regras da fila, contra Postgres real.
 *
 * Os gatilhos são testados sem banco em `@ops/metrics`. Aqui está o que decide
 * se a ferramenta continua sendo usada no terceiro mês: teto, deduplicação,
 * carência e modo sombra.
 *
 * O cenário é montado à mão, e não pela massa sintética: aqui as asserções são
 * sobre números exatos, e variabilidade realista atrapalharia.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import pg from 'pg'

import { avaliarFila, FLAG_GATILHO, TETO_POR_PESSOA } from './fila.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const COMP = '2026-07-30'
const AGORA = new Date('2026-07-30T09:00:00Z')
const CSM = 'ana@alloyal.com.br'

describe('fila de trabalho', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  /** Cria uma conta com o estado exato que se quer testar. */
  async function conta(opts: {
    nome: string
    diasAtraso?: number
    ativas?: number
    elegiveis?: number
    contratadas?: number
    csm?: string
    diasDesdeInicio?: number
    diasParaVigencia?: number
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ($1,'medio','industria',$2,$3) RETURNING id`,
      [opts.nome, `brand-${opts.nome}`, opts.csm ?? CSM],
    )
    const id = String(rows[0]!.id)
    // O contrato é obrigatório: sem ele não há data de início, e os gatilhos de
    // onboarding e renovação não têm contra o que medir. Toda conta real tem um.
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas, status_vigencia)
       VALUES ($1, 1000000, $2::date - $3::int, $2::date + $4::int, $5, 'vigente')`,
      [id, COMP, opts.diasDesdeInicio ?? 400, opts.diasParaVigencia ?? 300, opts.contratadas ?? 1100],
    )
    const el = opts.elegiveis ?? 1000
    const at = opts.ativas ?? 450
    await pool.query(
      `INSERT INTO metrics.daily_snapshot
         (competencia, account_id, vidas_contratadas, vidas_elegiveis, vidas_ativas_30d,
          transacoes, dias_atraso_max, valor_aberto_centavos)
       VALUES ($1,$2,$3,$4,$5,100,$6,$7)`,
      [COMP, id, opts.contratadas ?? 1100, el, at, opts.diasAtraso ?? 0, (opts.diasAtraso ?? 0) > 0 ? 500000 : 0],
    )
    return id
  }

  before(async () => {
    const { migrate } = await import('@ops/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE success.work_item, metrics.daily_snapshot, core.contract, core.account CASCADE',
    )
    await pool.query(`DELETE FROM ops.feature_flag WHERE chave LIKE '${FLAG_GATILHO}%'`)
  })

  /** Promove um gatilho para fora do modo sombra. */
  async function promover(...gatilhos: string[]) {
    for (const g of gatilhos) {
      await pool.query(
        `INSERT INTO ops.feature_flag (chave, habilitado) VALUES ($1, true)
         ON CONFLICT (chave) DO UPDATE SET habilitado = true`,
        [`${FLAG_GATILHO}${g}`],
      )
    }
  }

  // ── Modo sombra ───────────────────────────────────────────────────────────

  test('gatilho novo nasce em modo sombra, invisível para o time', async () => {
    // Nenhum gatilho vai direto à fila do time — inclusive na partida.
    await conta({ nome: 'a', diasAtraso: 40 })
    const r = await avaliarFila(pool, COMP, { agora: AGORA })

    assert.equal(r.criados, 1)
    assert.equal(r.emSombra, 1)
    const { rows } = await pool.query<{ modo_sombra: boolean; estado: string }>(
      'SELECT modo_sombra, estado FROM success.work_item',
    )
    assert.equal(rows[0]?.modo_sombra, true)
  })

  test('gatilho promovido chega à fila do time', async () => {
    await promover('G-01')
    await conta({ nome: 'a', diasAtraso: 40 })
    const r = await avaliarFila(pool, COMP, { agora: AGORA })

    assert.equal(r.emSombra, 0)
    const { rows } = await pool.query<{ modo_sombra: boolean; estado: string }>(
      'SELECT modo_sombra, estado FROM success.work_item',
    )
    assert.equal(rows[0]?.modo_sombra, false)
    assert.equal(rows[0]?.estado, 'aberto')
  })

  // ── Deduplicação por família ──────────────────────────────────────────────

  test('reavaliar não duplica: o segundo sinal atualiza a evidência', async () => {
    await promover('G-01', 'G-02')
    const id = await conta({ nome: 'a', diasAtraso: 40 })

    await avaliarFila(pool, COMP, { agora: AGORA })
    const primeiro = await pool.query<{ id: string; motivo: string }>(
      'SELECT id, motivo FROM success.work_item',
    )
    assert.equal(primeiro.rows.length, 1)
    assert.match(primeiro.rows[0]!.motivo, /40 dias/)

    // O atraso avança para outra faixa: MESMA família, mesmo trabalho.
    await pool.query(
      'UPDATE metrics.daily_snapshot SET dias_atraso_max = 70 WHERE account_id = $1',
      [id],
    )
    const r = await avaliarFila(pool, COMP, { agora: AGORA })

    assert.equal(r.criados, 0)
    assert.equal(r.atualizados, 1)
    const depois = await pool.query<{ id: string; motivo: string; prioridade: string }>(
      'SELECT id, motivo, prioridade FROM success.work_item',
    )
    assert.equal(depois.rows.length, 1, 'o mesmo atraso não pode virar dois itens')
    assert.equal(depois.rows[0]!.id, primeiro.rows[0]!.id, 'é o mesmo item, atualizado')
    assert.match(depois.rows[0]!.motivo, /70 dias/)
    assert.equal(depois.rows[0]!.prioridade, 'critica')
  })

  test('famílias diferentes na mesma conta convivem', async () => {
    await promover('G-01', 'G-06')
    await conta({ nome: 'a', diasAtraso: 40, elegiveis: 400, contratadas: 1000 })
    await avaliarFila(pool, COMP, { agora: AGORA })
    const { rows } = await pool.query<{ familia: string }>(
      'SELECT familia FROM success.work_item ORDER BY familia',
    )
    assert.deepEqual(rows.map((r) => r.familia), ['financeiro', 'onboarding'])
  })

  // ── Carência ──────────────────────────────────────────────────────────────

  test('item fechado não reabre pelo mesmo motivo antes da carência', async () => {
    // Sem carência, um cliente cronicamente em atraso reaparece toda semana e o
    // CSM aprende que fechar não adianta.
    await promover('G-01')
    await conta({ nome: 'a', diasAtraso: 40 })
    await avaliarFila(pool, COMP, { agora: AGORA })

    await pool.query(
      `UPDATE success.work_item SET estado='fechado', desfecho='resolvido',
              fechado_em = $1, fechado_por = $2`,
      [new Date(AGORA.getTime() - 5 * 86_400_000), CSM],
    )

    const r = await avaliarFila(pool, COMP, { agora: AGORA })
    assert.equal(r.criados, 0)
    assert.equal(r.bloqueadosPorCarencia, 1)
  })

  test('passada a carência, o item volta', async () => {
    await promover('G-01')
    await conta({ nome: 'a', diasAtraso: 40 })
    await avaliarFila(pool, COMP, { agora: AGORA })
    await pool.query(
      `UPDATE success.work_item SET estado='fechado', desfecho='resolvido',
              fechado_em = $1, fechado_por = $2`,
      [new Date(AGORA.getTime() - 40 * 86_400_000), CSM],
    )

    const r = await avaliarFila(pool, COMP, { agora: AGORA })
    assert.equal(r.criados, 1, 'a carência de 30 dias já passou')
  })

  // ── Teto de carga ─────────────────────────────────────────────────────────

  test('acima do teto, o excedente vai para o backlog e não para a fila', async () => {
    // Fila que passa de uma tela deixa de ser fila.
    await promover('G-01')
    for (let i = 0; i < TETO_POR_PESSOA + 4; i++) {
      await conta({ nome: `conta-${i}`, diasAtraso: 40 })
    }
    const r = await avaliarFila(pool, COMP, { agora: AGORA })

    assert.equal(r.criados, TETO_POR_PESSOA + 4)
    assert.equal(r.emBacklog, 4)

    const { rows } = await pool.query<{ estado: string; n: string }>(
      `SELECT estado, count(*) n FROM success.work_item GROUP BY estado ORDER BY estado`,
    )
    const abertos = rows.find((x) => x.estado === 'aberto')
    assert.equal(Number(abertos?.n), TETO_POR_PESSOA)
  })

  test('o teto corta o menos urgente, não o que chegou por último', async () => {
    await promover('G-01', 'G-03')
    // Preenche a fila com prioridade alta.
    for (let i = 0; i < TETO_POR_PESSOA; i++) await conta({ nome: `alta-${i}`, diasAtraso: 40 })
    // E acrescenta uma crítica, que deveria passar na frente.
    await conta({ nome: 'critica', diasAtraso: 120 })

    await avaliarFila(pool, COMP, { agora: AGORA })
    const { rows } = await pool.query<{ estado: string }>(
      `SELECT w.estado FROM success.work_item w
         JOIN core.account a ON a.id = w.account_id WHERE a.razao_social = 'critica'`,
    )
    assert.equal(rows[0]?.estado, 'aberto', 'a crítica não pode cair no backlog')
  })

  test('item em sombra não ocupa a fila de ninguém', async () => {
    // Ele existe para a liderança medir o volume que produziria; contá-lo no
    // teto falsearia a conta e empurraria item real para o backlog.
    for (let i = 0; i < TETO_POR_PESSOA + 5; i++) {
      await conta({ nome: `c-${i}`, diasAtraso: 40 })
    }
    const r = await avaliarFila(pool, COMP, { agora: AGORA })
    assert.equal(r.emSombra, TETO_POR_PESSOA + 5)
    assert.equal(r.emBacklog, 0)
  })

  test('cada pessoa tem o próprio teto', async () => {
    await promover('G-01')
    for (let i = 0; i < TETO_POR_PESSOA; i++) {
      await conta({ nome: `ana-${i}`, diasAtraso: 40, csm: 'ana@alloyal.com.br' })
    }
    await conta({ nome: 'bruno-1', diasAtraso: 40, csm: 'bruno@alloyal.com.br' })

    await avaliarFila(pool, COMP, { agora: AGORA })
    const { rows } = await pool.query<{ estado: string }>(
      `SELECT estado FROM success.work_item WHERE dono_email = 'bruno@alloyal.com.br'`,
    )
    assert.equal(rows[0]?.estado, 'aberto')
  })

  // ── Partida a frio ────────────────────────────────────────────────────────

  test('na partida, gatilhos de variação ficam de fora', async () => {
    // O histórico satisfaz a condição de todos ao mesmo tempo: sem esta trava, o
    // dia 1 entrega centenas de itens e o time não volta.
    await promover('G-01', 'G-04', 'G-08')
    const id = await conta({ nome: 'a', diasAtraso: 40, ativas: 300, elegiveis: 1000 })
    await pool.query(
      `INSERT INTO metrics.daily_snapshot (competencia, account_id, vidas_elegiveis, vidas_ativas_30d)
       VALUES ($1::date - INTERVAL '30 days', $2, 1000, 800)`,
      [COMP, id],
    )

    const frio = await avaliarFila(pool, COMP, { agora: AGORA, apenasEstadoCorrente: true })
    const gat = await pool.query<{ gatilho: string }>('SELECT gatilho FROM success.work_item')
    assert.ok(!gat.rows.some((g) => g.gatilho === 'G-04'), 'G-04 é de variação e não entra na partida')
    assert.ok(frio.criados > 0, 'os de estado corrente entram normalmente')
  })

  // ── Roteamento ────────────────────────────────────────────────────────────

  test('conta sem CSM não gera item órfão', async () => {
    // Item que ninguém possui é item que ninguém fecha: ele envelhece na fila
    // até virar ruído.
    await promover('G-01')
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, brand_id, csm_email)
       VALUES ('sem dono','medio','brand-x',NULL) RETURNING id`,
    )
    await pool.query(
      `INSERT INTO metrics.daily_snapshot
         (competencia, account_id, vidas_contratadas, vidas_elegiveis, vidas_ativas_30d, dias_atraso_max)
       VALUES ($1,$2,1000,900,400,40)`,
      [COMP, rows[0]!.id],
    )
    const r = await avaliarFila(pool, COMP, { agora: AGORA })
    assert.equal(r.criados, 0)
  })

  test('reavaliar a mesma competência é idempotente', async () => {
    await promover('G-01', 'G-06')
    await conta({ nome: 'a', diasAtraso: 40, elegiveis: 400, contratadas: 1000 })
    await avaliarFila(pool, COMP, { agora: AGORA })
    const antes = await pool.query<{ n: string }>('SELECT count(*) n FROM success.work_item')
    await avaliarFila(pool, COMP, { agora: AGORA })
    const depois = await pool.query<{ n: string }>('SELECT count(*) n FROM success.work_item')
    assert.equal(depois.rows[0]?.n, antes.rows[0]?.n)
  })
})
