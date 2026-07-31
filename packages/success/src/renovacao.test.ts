/**
 * Renovação e a medição da previsão.
 *
 * O que se testa aqui, acima de tudo, é a ACURÁCIA. Previsão sem medição é um
 * número bonito que ninguém consegue contestar — e um CSM que marca tudo como
 * otimista produz exatamente isso. O O6 pede ±10%, e uma meta inverificável é o
 * mesmo que meta nenhuma.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@pulse/auth'
import pg from 'pg'

import {
  abrirJanela,
  acuracia,
  calendario,
  darDesfecho,
  JANELA_DIAS,
  listar,
  marcarCenario,
  META_ERRO_O6,
  MINIMO_PARA_ACURACIA,
  perderPorSaida,
  previsao,
  RenovacaoInvalidaError,
  SemPermissaoRenovacao,
} from './renovacao.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const HOJE = '2026-07-31'

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const ANA = quem('ana@alloyal.com.br', 'pulse-csm')
const BRUNO = quem('bruno@alloyal.com.br', 'pulse-csm')
const LIDER = quem('lider@alloyal.com.br', 'pulse-cs-lead')
const COMERCIAL = quem('com@alloyal.com.br', 'pulse-comercial')

test('a janela é a mesma do gatilho G-09', () => {
  // Mudar aqui sem mudar lá faria a meta ser medida contra um número que ninguém
  // previu: o item de trabalho abriria em 90 dias e a previsão em outro prazo.
  assert.equal(JANELA_DIAS, 90)
})

describe('renovação', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  before(async () => {
    const { migrate } = await import('@pulse/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE success.renewal, core.contract, core.account CASCADE')
  })

  /** Conta com contrato vencendo em N dias a partir de HOJE. */
  async function conta(
    nome: string,
    diasParaVencer: number,
    mrr: number,
    csm = ANA.email,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ($1,'medio','industria',$2,$3) RETURNING id`,
      [nome, `b-${nome}`, csm],
    )
    const id = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas,
          aviso_previo_dias, status_vigencia)
       VALUES ($1,$2,'2024-01-01',$3::date + $4::int,1000,60,'vigente')`,
      [id, mrr, HOJE, diasParaVencer],
    )
    return id
  }

  // ── Abertura da janela ────────────────────────────────────────────────────

  test('abre só o que está dentro dos 90 dias', async () => {
    await conta('dentro', 45, 1_000_000)
    await conta('fora', 200, 2_000_000)
    const r = await abrirJanela(pool, { hoje: HOJE })
    assert.equal(r.abertas, 1)
    const abertas = await listar(pool, LIDER)
    assert.equal(abertas.length, 1)
    assert.equal(abertas[0]?.conta, 'dentro')
  })

  test('rodar duas vezes não duplica', async () => {
    // O ciclo roda todo dia — é isso que garante que ninguém descubra um
    // vencimento pelo vencimento. Duplicar dobraria o MRR na previsão.
    await conta('acme', 45, 1_000_000)
    assert.equal((await abrirJanela(pool, { hoje: HOJE })).abertas, 1)
    const segunda = await abrirJanela(pool, { hoje: HOJE })
    assert.equal(segunda.abertas, 0)
    assert.equal(segunda.jaAbertas, 1)
    assert.equal((await listar(pool, LIDER)).length, 1)
  })

  test('contrato já encerrado não gera renovação', async () => {
    // Ele não vai renovar. Abrir uma renovação para quem saiu põe receita de
    // cliente perdido na previsão.
    const c = await conta('saiu', 45, 1_000_000)
    await pool.query(
      `UPDATE core.contract SET encerrado_em = $1::date - 10, status_vigencia = 'encerrado'
        WHERE account_id = $2`,
      [HOJE, c],
    )
    assert.equal((await abrirJanela(pool, { hoje: HOJE })).abertas, 0)
  })

  test('vigência já vencida não abre janela', async () => {
    await conta('vencida', -5, 1_000_000)
    assert.equal((await abrirJanela(pool, { hoje: HOJE })).abertas, 0)
  })

  test('o MRR é congelado na abertura', async () => {
    // O contrato pode ser reajustado durante a negociação, e o que estava em risco
    // quando a janela abriu é o número contra o qual a previsão será medida.
    const c = await conta('acme', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    await pool.query('UPDATE core.contract SET mrr_centavos = 5_000_000 WHERE account_id = $1', [c])
    const [r] = await listar(pool, LIDER)
    assert.equal(r?.mrrEmRiscoCentavos, '1000000')
  })

  test('o aviso prévio vem junto — é o prazo real de decisão', async () => {
    // "Vence em 45 dias" parece folga até se ver que o aviso é de 60 e o cliente
    // já poderia ter avisado.
    await conta('acme', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    assert.equal(r?.avisoPrevioDias, 60)
    assert.equal(r?.diasParaVigencia, 45)
  })

  // ── Cenário e desfecho ────────────────────────────────────────────────────

  test('marcar cenário move para em_negociacao', async () => {
    // A diferença entre "abriu a janela" e "alguém olhou" é o que separa uma lista
    // de vencimentos de um pipeline.
    await conta('acme', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    await marcarCenario(pool, ANA, r!.id, 'base', 'reunião marcada para dia 10')

    const [depois] = await listar(pool, LIDER)
    assert.equal(depois?.estado, 'em_negociacao')
    assert.equal(depois?.cenario, 'base')
    assert.match(String(depois?.nota), /dia 10/)
  })

  test('o cenário não muda depois do desfecho', async () => {
    // Senão a acurácia é reescrita para bater: marcar "pessimista" depois de
    // perder transforma todo erro em acerto.
    await conta('acme', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    await marcarCenario(pool, ANA, r!.id, 'base')
    await darDesfecho(pool, ANA, r!.id, 'perdida')
    await assert.rejects(
      () => marcarCenario(pool, ANA, r!.id, 'pessimista'),
      RenovacaoInvalidaError,
    )
  })

  test('fechar duas vezes é recusado', async () => {
    await conta('acme', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    await darDesfecho(pool, ANA, r!.id, 'renovada')
    await assert.rejects(() => darDesfecho(pool, ANA, r!.id, 'perdida'), RenovacaoInvalidaError)
  })

  test('quem não tem fila não conduz renovação', async () => {
    await conta('acme', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    await assert.rejects(() => marcarCenario(pool, COMERCIAL, r!.id, 'base'), SemPermissaoRenovacao)
  })

  // ── A previsão como faixa ─────────────────────────────────────────────────

  test('a previsão é uma faixa, não um número', async () => {
    // Número único é falsa precisão. Faixa é o que um board consegue usar.
    await conta('otimista', 30, 1_000_000)
    await conta('base', 40, 2_000_000)
    await conta('pessimista', 50, 4_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const rs = await listar(pool, LIDER)
    const porNome = new Map(rs.map((r) => [r.conta, r.id]))
    await marcarCenario(pool, ANA, porNome.get('otimista')!, 'otimista')
    await marcarCenario(pool, ANA, porNome.get('base')!, 'base')
    await marcarCenario(pool, ANA, porNome.get('pessimista')!, 'pessimista')

    const p = await previsao(pool, { hoje: HOJE })
    assert.equal(p.mrrTotalCentavos, '7000000')
    assert.equal(p.otimistaCentavos, '7000000', 'teto: tudo renova')
    assert.equal(p.baseCentavos, '3000000', 'o que não foi marcado como pessimista')
    assert.equal(p.pessimistaCentavos, '1000000', 'piso: só o marcado como otimista')
  })

  test('renovação sem cenário conta em base E aparece como não avaliada', async () => {
    // Previsão que assume em silêncio que o não avaliado renova é previsão que se
    // lisonjeia. O número aparece para quem lê saber quanto é julgamento e quanto
    // é omissão.
    await conta('avaliada', 30, 1_000_000)
    await conta('esquecida', 40, 3_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const rs = await listar(pool, LIDER)
    await marcarCenario(pool, ANA, rs.find((r) => r.conta === 'avaliada')!.id, 'base')

    const p = await previsao(pool, { hoje: HOJE })
    assert.equal(p.baseCentavos, '4000000', 'a não avaliada entra no base')
    assert.equal(p.semAvaliacao, 1)
    assert.equal(p.mrrSemAvaliacaoCentavos, '3000000')
  })

  test('renovação fechada sai da previsão', async () => {
    await conta('acme', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    await darDesfecho(pool, ANA, r!.id, 'renovada')
    assert.equal((await previsao(pool, { hoje: HOJE })).quantas, 0)
  })

  // ── O6: a acurácia ────────────────────────────────────────────────────────

  test('o erro do O6 é |previsto − realizado| sobre realizado', async () => {
    // Duas contas previstas como base (R$ 30 mil), uma renovou (R$ 10 mil):
    // erro = |30.000 − 10.000| / 10.000 = 2,0 — muito acima da meta de 0,10.
    await conta('renovou', 30, 1_000_000)
    await conta('perdeu', 40, 2_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const rs = await listar(pool, LIDER)
    for (const r of rs) await marcarCenario(pool, ANA, r.id, 'base')
    await darDesfecho(pool, ANA, rs.find((r) => r.conta === 'renovou')!.id, 'renovada')
    await darDesfecho(pool, ANA, rs.find((r) => r.conta === 'perdeu')!.id, 'perdida')

    const a = await acuracia(pool, { desde: '2026-01-01' })
    assert.equal(a.previstoBaseCentavos, '3000000')
    assert.equal(a.realizadoCentavos, '1000000')
    assert.equal(a.erro, 2)
    assert.ok(a.erro! > META_ERRO_O6, 'e a meta é 0,10')
  })

  test('previsão certa dá erro zero', async () => {
    await conta('renovou', 30, 1_000_000)
    await conta('perdeu', 40, 2_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const rs = await listar(pool, LIDER)
    await marcarCenario(pool, ANA, rs.find((r) => r.conta === 'renovou')!.id, 'base')
    await marcarCenario(pool, ANA, rs.find((r) => r.conta === 'perdeu')!.id, 'pessimista')
    await darDesfecho(pool, ANA, rs.find((r) => r.conta === 'renovou')!.id, 'renovada')
    await darDesfecho(pool, ANA, rs.find((r) => r.conta === 'perdeu')!.id, 'perdida')

    const a = await acuracia(pool, { desde: '2026-01-01' })
    assert.equal(a.erro, 0)
    assert.equal(a.acertos, 2)
  })

  test('sem nada renovado o erro é nulo, não infinito', async () => {
    // Um trimestre sem renovação é catástrofe de retenção, não de previsão, e
    // mostrar ∞ confundiria as duas.
    await conta('perdeu', 40, 2_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    await darDesfecho(pool, ANA, r!.id, 'perdida')
    assert.equal((await acuracia(pool, { desde: '2026-01-01' })).erro, null)
  })

  test('taxa de acerto abaixo do mínimo é nula, não um número enganoso', async () => {
    // Uma em três vira "33%" e reprova quem fez duas chamadas certas.
    await conta('a', 30, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const [r] = await listar(pool, LIDER)
    await marcarCenario(pool, ANA, r!.id, 'base')
    await darDesfecho(pool, ANA, r!.id, 'renovada')
    const a = await acuracia(pool, { desde: '2026-01-01' })
    assert.equal(a.fechadas, 1)
    assert.ok(a.fechadas < MINIMO_PARA_ACURACIA)
    assert.equal(a.taxaAcerto, null)
  })

  test('sem cenário não é acerto — ausência de chamada não vira acerto', async () => {
    // É o incentivo que importa: quem não avalia não pode aparecer com 100%.
    for (let i = 0; i < 5; i++) await conta(`c${i}`, 30 + i, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    for (const r of await listar(pool, LIDER)) await darDesfecho(pool, ANA, r.id, 'renovada')
    const a = await acuracia(pool, { desde: '2026-01-01' })
    assert.equal(a.fechadas, 5)
    assert.equal(a.acertos, 0)
    assert.equal(a.taxaAcerto, 0)
  })

  test('a acurácia sai por CSM, para a conversa ser com quem faz a chamada', async () => {
    await conta('da-ana', 30, 1_000_000, ANA.email)
    await conta('do-bruno', 40, 2_000_000, BRUNO.email)
    await abrirJanela(pool, { hoje: HOJE })
    const rs = await listar(pool, LIDER)
    await marcarCenario(pool, LIDER, rs.find((r) => r.conta === 'da-ana')!.id, 'base')
    await marcarCenario(pool, LIDER, rs.find((r) => r.conta === 'do-bruno')!.id, 'base')
    await darDesfecho(pool, LIDER, rs.find((r) => r.conta === 'da-ana')!.id, 'renovada')
    await darDesfecho(pool, LIDER, rs.find((r) => r.conta === 'do-bruno')!.id, 'perdida')

    const a = await acuracia(pool, { desde: '2026-01-01' })
    const porCsm = new Map(a.porCsm.map((c) => [c.csm, c]))
    assert.equal(porCsm.get(ANA.email)?.acertos, 1)
    assert.equal(porCsm.get(BRUNO.email)?.acertos, 0)
  })

  // ── Ligação com a saída ───────────────────────────────────────────────────

  test('conta que saiu tem a renovação fechada como perdida', async () => {
    // Sem isto, a conta sai pela porta da saída e continua na previsão como
    // receita esperada — dois módulos contando a mesma conta de formas opostas.
    const c = await conta('saindo', 45, 1_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const fechadas = await perderPorSaida(pool, c, 'fin@alloyal.com.br')

    assert.equal(fechadas, 1)
    const [r] = await listar(pool, LIDER)
    assert.equal(r?.estado, 'perdida')
    assert.match(String(r?.nota), /saída encerrada por fin@alloyal.com.br/)
    assert.equal((await previsao(pool, { hoje: HOJE })).quantas, 0)
  })

  // ── Recorte e calendário ──────────────────────────────────────────────────

  test('o CSM vê as renovações da própria carteira', async () => {
    await conta('da-ana', 30, 1_000_000, ANA.email)
    await conta('do-bruno', 40, 2_000_000, BRUNO.email)
    await abrirJanela(pool, { hoje: HOJE })
    assert.equal((await listar(pool, ANA)).length, 1)
    assert.equal((await listar(pool, LIDER)).length, 2)
  })

  test('o calendário agrupa por mês de vencimento', async () => {
    await conta('agosto', 10, 1_000_000)
    await conta('setembro', 40, 2_000_000)
    await abrirJanela(pool, { hoje: HOJE })
    const cal = await calendario(pool, 12)
    assert.ok(cal.length >= 2)
    assert.equal(
      cal.reduce((s, m) => s + Number(m.mrrCentavos), 0),
      3_000_000,
    )
  })
})
