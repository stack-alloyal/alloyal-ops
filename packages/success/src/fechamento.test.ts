/**
 * A cascata de receita.
 *
 * O que se testa aqui, acima de tudo, é o RESÍDUO. O MRR final é observado na
 * base de contratos, não somado a partir dos eventos: são duas fontes
 * independentes, e a diferença tem que aparecer com nome próprio. Um gráfico que
 * fecha sempre é um gráfico que ninguém consegue auditar — e o jeito mais fácil
 * de fazê-lo fechar sempre é empurrar o que sobra para churn.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import pg from 'pg'

import {
  competenciaAnterior,
  CompetenciaCongeladaError,
  congelar,
  fechar,
  indicadores,
  lerCascata,
} from './fechamento.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const JUL = '2026-07-01'
const AGO = '2026-08-01'

// ── As funções puras ────────────────────────────────────────────────────────

test('a competência anterior atravessa o ano', () => {
  assert.equal(competenciaAnterior('2026-07-01'), '2026-06-01')
  assert.equal(competenciaAnterior('2026-01-01'), '2025-12-01')
})

test('NRR e GRR excluem cliente novo', () => {
  // Incluí-lo infla o indicador e esconde contração na base que já existia — é o
  // erro que faz uma empresa achar que retém bem enquanto sangra na coorte.
  const r = indicadores({
    mrrInicial: 1_000_000,
    expansao: 200_000,
    reativacao: 0,
    contracao: 50_000,
    churnTotal: 100_000,
  })
  assert.equal(r.grr, 0.85, '(1.000.000 − 50.000 − 100.000) / 1.000.000')
  assert.equal(r.nrr, 1.05, 'com a expansão de 200.000')
})

test('sem MRR inicial os indicadores são nulos, não zero nem infinito', () => {
  // 0% faria o primeiro mês de operação parecer catástrofe; ∞, milagre.
  const r = indicadores({ mrrInicial: 0, expansao: 5000, reativacao: 0, contracao: 0, churnTotal: 0 })
  assert.equal(r.nrr, null)
  assert.equal(r.grr, null)
})

// ── Contra banco ────────────────────────────────────────────────────────────

describe('fechamento mensal', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  before(async () => {
    const { migrate } = await import('@ops/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    // Competência congelada resiste ao DELETE por trigger — e derrubar o teardown
    // com a própria invariante deixaria a suíte pendurada.
    await pool
      ?.query('ALTER TABLE analytics.monthly_close DISABLE TRIGGER USER')
      .catch(() => undefined)
    await pool?.query('TRUNCATE analytics.monthly_close').catch(() => undefined)
    await pool
      ?.query('ALTER TABLE analytics.monthly_close ENABLE TRIGGER USER')
      .catch(() => undefined)
    await pool?.end()
  })

  /** Uma conta com contrato vigente, e o evento de entrada correspondente. */
  async function conta(nome: string, mrr: number, inicio: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id)
       VALUES ($1,'medio','industria',$2) RETURNING id`,
      [nome, `b-${nome}`],
    )
    const id = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract (account_id, mrr_centavos, inicio, vidas_contratadas, status_vigencia)
       VALUES ($1,$2,$3::date,1000,'vigente')`,
      [id, mrr, inicio],
    )
    return id
  }

  async function evento(
    accountId: string,
    competencia: string,
    valor: number,
    tipo: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO fact.mrr_event (account_id, competencia, valor_centavos, tipo, origem, chave_natural)
       VALUES ($1,$2::date,$3,$4,'ops',$5)`,
      [accountId, competencia, valor, tipo, `${tipo}:${accountId}:${competencia}`],
    )
  }

  beforeEach(async () => {
    await pool.query('ALTER TABLE analytics.monthly_close DISABLE TRIGGER USER')
    await pool.query(
      'TRUNCATE analytics.monthly_close, fact.mrr_event, core.contract, core.account CASCADE',
    )
    await pool.query('ALTER TABLE analytics.monthly_close ENABLE TRIGGER USER')
  })

  // ── A identidade da cascata ───────────────────────────────────────────────

  test('a cascata fecha, e o resíduo é zero quando o ledger explica tudo', async () => {
    const a = await conta('antiga', 1_000_000, '2025-01-01')
    await conta('nova', 300_000, '2026-07-05')
    const nova = (
      await pool.query<{ id: string }>(`SELECT id FROM core.account WHERE razao_social='nova'`)
    ).rows[0]!.id
    await evento(nova, JUL, 300_000, 'novo')
    await evento(a, JUL, 0, 'ajuste')

    const c = await fechar(pool, JUL)
    assert.equal(c.mrrInicialCentavos, '1000000')
    assert.equal(c.novoCentavos, '300000')
    assert.equal(c.mrrFinalCentavos, '1300000')
    assert.equal(c.naoAtribuidoCentavos, '0', 'o ledger explicou a variação inteira')
  })

  test('o resíduo APARECE quando o ledger não explica a variação', async () => {
    // É o ponto do arquivo. Uma conta entrou na base sem evento no ledger — que
    // é exatamente o que acontece quando um ciclo de captação falha. O número
    // certo é o resíduo visível, e não churn inflado para o gráfico fechar.
    await conta('antiga', 1_000_000, '2025-01-01')
    await conta('fantasma', 250_000, '2026-07-10')

    const c = await fechar(pool, JUL)
    assert.equal(c.naoAtribuidoCentavos, '250000')
    assert.equal(c.churnPedidoCentavos, '0', 'nada foi empurrado para churn')
    assert.equal(
      Number(c.mrrFinalCentavos),
      Number(c.mrrInicialCentavos) + Number(c.naoAtribuidoCentavos),
      'a identidade continua fechando — pelo resíduo, não por conta errada',
    )
  })

  test('resíduo negativo também aparece, e não vira contração', async () => {
    const a = await conta('some', 400_000, '2025-01-01')
    await conta('fica', 600_000, '2025-01-01')
    await pool.query(
      `UPDATE core.contract SET status_vigencia='encerrado' WHERE account_id=$1`,
      [a],
    )

    const c = await fechar(pool, JUL)
    assert.equal(c.naoAtribuidoCentavos, '-400000')
    assert.equal(c.contracaoCentavos, '0')
    assert.equal(c.churnPedidoCentavos, '0')
  })

  // ── Encadeamento entre competências ───────────────────────────────────────

  test('o MRR inicial vem do fechamento anterior, não da base recalculada', async () => {
    // Encadear é o que garante que a soma do ano bate com a soma dos meses.
    // Recalcular da base a cada mês faria buracos aparecerem e sumirem sozinhos.
    await conta('a', 1_000_000, '2025-01-01')
    const julho = await fechar(pool, JUL)

    await conta('b', 500_000, '2026-08-02')
    const agosto = await fechar(pool, AGO)
    assert.equal(agosto.mrrInicialCentavos, julho.mrrFinalCentavos)
  })

  // ── Churn separado por origem ─────────────────────────────────────────────

  test('churn pedido e churn por inadimplência não são somados no mesmo balde', async () => {
    // São conversas diferentes: um é insatisfação, o outro é crédito.
    const a = await conta('a', 1_000_000, '2025-01-01')
    const b = await conta('b', 400_000, '2025-01-01')
    await evento(a, JUL, -200_000, 'churn_pedido')
    await evento(b, JUL, -150_000, 'churn_inadimplencia')

    const c = await fechar(pool, JUL)
    assert.equal(c.churnPedidoCentavos, '200000')
    assert.equal(c.churnInadimplenciaCentavos, '150000')
    assert.equal(c.contasPerdidas, 2)
  })

  test('o churn entra positivo na cascata mesmo vindo negativo do ledger', async () => {
    // O ledger guarda o sinal; a cascata guarda a magnitude e o sinal está na
    // fórmula. Misturar as duas convenções é como um mês fecha com o dobro.
    const a = await conta('a', 1_000_000, '2025-01-01')
    await evento(a, JUL, -300_000, 'churn_pedido')
    const c = await fechar(pool, JUL)
    assert.equal(c.churnPedidoCentavos, '300000')
  })

  // ── NRR e GRR ─────────────────────────────────────────────────────────────

  test('NRR e GRR são gravados na competência', async () => {
    const a = await conta('a', 1_000_000, '2025-01-01')
    await evento(a, JUL, 100_000, 'expansao')
    const c = await fechar(pool, JUL)
    assert.equal(c.grr, 1)
    assert.equal(c.nrr, 1.1)
  })

  // ── Congelamento ──────────────────────────────────────────────────────────

  test('competência congelada recusa recálculo, com o caminho no texto', async () => {
    await conta('a', 1_000_000, '2025-01-01')
    await fechar(pool, JUL)
    await congelar(pool, JUL, 'diretoria@alloyal.com.br')

    await assert.rejects(
      () => fechar(pool, JUL),
      (e: Error) => {
        assert.ok(e instanceof CompetenciaCongeladaError)
        assert.match(e.message, /ajuste na competência corrente/)
        return true
      },
    )
  })

  test('congelar duas vezes é recusado — o autor da primeira é que vale', async () => {
    await conta('a', 1_000_000, '2025-01-01')
    await fechar(pool, JUL)
    await congelar(pool, JUL, 'primeiro@alloyal.com.br')
    await assert.rejects(
      () => congelar(pool, JUL, 'segundo@alloyal.com.br'),
      CompetenciaCongeladaError,
    )
    const c = await lerCascata(pool, JUL)
    assert.equal(c?.congeladoPor, 'primeiro@alloyal.com.br')
  })

  test('o congelamento registra quem e quando', async () => {
    await conta('a', 1_000_000, '2025-01-01')
    await fechar(pool, JUL)
    await congelar(pool, JUL, 'diretoria@alloyal.com.br')
    const c = await lerCascata(pool, JUL)
    assert.equal(c?.estado, 'congelada')
    assert.ok(c?.congeladoEm)
  })

  test('a competência seguinte continua aberta depois do congelamento', async () => {
    // Congelar julho não pode travar agosto, senão o fechamento vira um portão
    // que ninguém quer atravessar.
    await conta('a', 1_000_000, '2025-01-01')
    await fechar(pool, JUL)
    await congelar(pool, JUL, 'diretoria@alloyal.com.br')
    const agosto = await fechar(pool, AGO)
    assert.equal(agosto.estado, 'aberta')
  })

  // ── Recálculo ─────────────────────────────────────────────────────────────

  test('refazer uma competência aberta atualiza em vez de duplicar', async () => {
    const a = await conta('a', 1_000_000, '2025-01-01')
    await fechar(pool, JUL)
    await evento(a, JUL, 50_000, 'expansao')
    const c = await fechar(pool, JUL)

    assert.equal(c.expansaoCentavos, '50000')
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) n FROM analytics.monthly_close',
    )
    assert.equal(rows[0]?.n, '1')
  })
})
