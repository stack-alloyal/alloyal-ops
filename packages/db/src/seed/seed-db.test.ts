/**
 * Seed contra banco real.
 *
 * O gerador é testado sem banco em `seed.test.ts`. Aqui está o que só falha
 * contra Postgres: reexecução, guarda contra base com dado real, e integridade
 * referencial da massa escrita.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import pg from 'pg'

import { migrate } from '../migrate.js'
import { semear, semearComGuarda } from './index.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const OPTS = { contas: 12, dias: 45, hoje: new Date('2026-07-30T00:00:00Z') }

describe('seed contra banco', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  before(async () => {
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    await pool?.end()
  })

  test('semear duas vezes seguidas funciona e não duplica', async () => {
    // O primeiro `make seed` de um banco vazio sempre passa: DELETE em tabela
    // vazia não dispara trigger de linha. É a SEGUNDA execução que encontra o
    // append-only de `fact` — e é a execução mais comum no dia a dia.
    const a = await semear(pool, OPTS)
    const b = await semear(pool, OPTS)
    assert.deepEqual(a, b)

    const { rows } = await pool.query<{ n: string }>('SELECT count(*) n FROM core.account')
    assert.equal(Number(rows[0]?.n), OPTS.contas)
  })

  test('a massa é referencialmente íntegra', async () => {
    await semear(pool, OPTS)
    const orfas = await pool.query<{ tabela: string; n: string }>(
      `SELECT 'transaction_daily' tabela, count(*) n FROM fact.transaction_daily t
         LEFT JOIN core.account a ON a.id = t.account_id WHERE a.id IS NULL
       UNION ALL
       SELECT 'daily_snapshot', count(*) FROM metrics.daily_snapshot s
         LEFT JOIN core.account a ON a.id = s.account_id WHERE a.id IS NULL
       UNION ALL
       SELECT 'mrr_event', count(*) FROM fact.mrr_event e
         LEFT JOIN core.account a ON a.id = e.account_id WHERE a.id IS NULL`,
    )
    for (const r of orfas.rows) assert.equal(Number(r.n), 0, `${r.tabela} tem linha órfã`)
  })

  test('a guarda recusa banco com conta que o seed não criou', async () => {
    await semear(pool, OPTS)
    await pool.query(
      `INSERT INTO core.account (razao_social, brand_id) VALUES ('Cliente de verdade', NULL)`,
    )
    // A diferença entre local e produção é uma variável de ambiente, e semear
    // apaga tudo antes de escrever.
    await assert.rejects(semearComGuarda(pool, OPTS), /apagaria dado real/)
    // Com `forcar`, quem chamou assumiu o risco explicitamente.
    await semearComGuarda(pool, { ...OPTS, forcar: true })
    await pool.query(`DELETE FROM core.account WHERE brand_id IS NULL`)
  })

  test('o snapshot recebe as colunas de origem e nenhuma conclusão', async () => {
    await semear(pool, OPTS)
    const { rows } = await pool.query<{
      com_origem: string
      completos: string
      com_qualidade: string
    }>(
      `SELECT count(*) FILTER (WHERE vidas_elegiveis IS NOT NULL) com_origem,
              count(*) FILTER (WHERE completo) completos,
              count(*) FILTER (WHERE qualidade_por_fonte <> '{}'::jsonb) com_qualidade
         FROM metrics.daily_snapshot`,
    )
    assert.ok(Number(rows[0]?.com_origem) > 0)
    // `completo` e `qualidade_por_fonte` são conclusões da consolidação. Se o
    // seed as preenchesse, a consolidação passaria a ser testada contra o que o
    // seed decidiu, e não contra os fatos.
    assert.equal(Number(rows[0]?.completos), 0)
    assert.equal(Number(rows[0]?.com_qualidade), 0)
  })

  test('a saída em curso fica sem efeito na receita até o Financeiro confirmar', async () => {
    await semear(pool, OPTS)
    const { rows } = await pool.query<{ n: string; indefinidos: string }>(
      `SELECT count(*) n, count(*) FILTER (WHERE competencia_efeito_receita IS NULL) indefinidos
         FROM success.cancellation WHERE estado = 'em_aviso'`,
    )
    assert.ok(Number(rows[0]?.n) > 0, 'a massa precisa ter saída em curso')
    // É o estado que a tela de saídas mostra como "efeito na receita indefinido"
    // e que cobra a segunda confirmação.
    assert.equal(Number(rows[0]?.indefinidos), Number(rows[0]?.n))
  })
})
