/**
 * A carteira.
 *
 * A decisão que este arquivo protege é a ORDEM. Por faixa só, o CSM começa por uma
 * conta crítica de R$ 800 e deixa uma em risco de R$ 40 mil para depois. Por MRR só,
 * começa pela maior mesmo saudável. A ordem é o produto dos dois, e é a única que
 * responde "qual conversa eu tenho hoje".
 *
 * E o segundo cuidado: conta SEM SINAL não é conta saudável. Somá-la ao verde faria
 * a carteira parecer melhor do que é — a leitura que atrasa a descoberta de um
 * problema.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@pulse/auth'
import pg from 'pg'

import { carregarCarteira, PESO_FAIXA, resumir } from './carteira.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const COMP = '2026-07-31'

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const ANA = quem('ana@alloyal.com.br', 'pulse-csm')
const BRUNO = quem('bruno@alloyal.com.br', 'pulse-csm')
const LIDER = quem('lider@alloyal.com.br', 'pulse-cs-lead')
// Autenticado e em NENHUM grupo `pulse-*`. É o caso real do dia 1 de um piloto, e o
// que a guarda de escopo defende: todo papel declarado enxerga contas, então o
// único jeito de não enxergar é não ter papel.
const SEM_GRUPO = quem('novo@alloyal.com.br')

test('a faixa pior pesa mais que a melhor', () => {
  assert.ok(PESO_FAIXA['critico']! > PESO_FAIXA['risco']!)
  assert.ok(PESO_FAIXA['risco']! > PESO_FAIXA['atencao']!)
  assert.ok(PESO_FAIXA['atencao']! > PESO_FAIXA['saudavel']!)
})

describe('carteira', { skip: !ADMIN }, () => {
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
    await pool.query(
      `TRUNCATE success.work_item, contracts.clause, contracts.document,
                metrics.signal_driver, metrics.signal, metrics.daily_snapshot,
                core.contract, core.account CASCADE`,
    )
  })

  async function conta(
    nome: string,
    opts: {
      mrr?: number
      faixa?: string
      score?: number
      elegiveis?: number
      ativas?: number
      contratadas?: number
      atraso?: number
      completo?: boolean
      csm?: string
      semSnapshot?: boolean
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ($1,'medio','industria',$2,$3) RETURNING id`,
      [nome, `b-${nome}`, opts.csm ?? ANA.email],
    )
    const id = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas, status_vigencia)
       VALUES ($1,$2,'2024-01-01',$3::date + 200,1000,'vigente')`,
      [id, opts.mrr ?? 1_000_000, COMP],
    )
    if (!opts.semSnapshot) {
      await pool.query(
        `INSERT INTO metrics.daily_snapshot
           (competencia, account_id, vidas_contratadas, vidas_elegiveis, vidas_ativas_30d,
            transacoes, dias_atraso_max, dias_desde_ultimo_contato, completo)
         VALUES ($1,$2,$3,$4,$5,100,$6,20,$7)`,
        [
          COMP,
          id,
          opts.contratadas ?? 1000,
          opts.elegiveis ?? 800,
          opts.ativas ?? 240,
          opts.atraso ?? 0,
          opts.completo ?? true,
        ],
      )
    }
    if (opts.faixa) {
      await pool.query(
        `INSERT INTO metrics.signal
           (competencia, account_id, score_composto, drivers_usados, parcial,
            faixa_por_regra, faixa_final)
         VALUES ($1,$2,$3,5,false,$4,$4)`,
        [COMP, id, opts.score ?? 50, opts.faixa],
      )
    }
    return id
  }

  // ── A ordem ──────────────────────────────────────────────────────────────

  test('a ordem é risco VEZES receita, não uma das duas', async () => {
    // Por faixa só, a crítica pequena vinha primeiro. Por MRR só, a saudável grande
    // vinha primeira. Nenhuma das duas responde "qual conversa eu tenho hoje".
    await conta('critica-pequena', { faixa: 'critico', mrr: 80_000 })
    await conta('risco-grande', { faixa: 'risco', mrr: 4_000_000 })
    await conta('saudavel-enorme', { faixa: 'saudavel', mrr: 9_000_000 })

    const { contas } = await carregarCarteira(pool, LIDER, { hoje: COMP })
    // risco(4) × R$ 40.000 = 160.000 · saudável(1) × R$ 90.000 = 90.000 ·
    // crítico(8) × R$ 800 = 6.400. Uma conta em RISCO de R$ 40 mil vem antes de uma
    // SAUDÁVEL de R$ 90 mil, e as duas antes de uma CRÍTICA de R$ 800 — que é
    // exatamente a conversa que o CSM deveria ter primeiro.
    assert.deepEqual(
      contas.map((c) => c.razaoSocial),
      ['risco-grande', 'saudavel-enorme', 'critica-pequena'],
    )
    assert.ok(contas[0]!.pesoDeAtencao > contas[1]!.pesoDeAtencao)
  })

  test('faixa pior vence quando o MRR é parecido', async () => {
    await conta('em-risco', { faixa: 'risco', mrr: 1_000_000 })
    await conta('saudavel', { faixa: 'saudavel', mrr: 1_000_000 })
    const { contas } = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(contas[0]?.razaoSocial, 'em-risco')
  })

  test('conta sem MRR não afunda para o fim por acidente', async () => {
    // Ela tem peso zero pela aritmética, e o desempate por nome a mantém achável.
    await conta('sem-contrato', { faixa: 'critico', semSnapshot: true })
    await pool.query(`UPDATE core.contract SET status_vigencia = 'encerrado'`)
    const { contas } = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(contas.length, 1)
    assert.equal(contas[0]?.mrrCentavos, null)
  })

  // ── Sem sinal não é saudável ─────────────────────────────────────────────

  test('conta sem sinal calculado é contada à parte, não como saudável', async () => {
    // Somá-la ao verde faria a carteira parecer melhor do que é.
    await conta('com-sinal', { faixa: 'saudavel' })
    await conta('sem-sinal')
    const carteira = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(carteira.semSinal, 1)

    const r = resumir(carteira)
    const faixas = new Map(r.porFaixa.map((f) => [f.faixa, f.contas]))
    assert.equal(faixas.get('saudavel'), 1)
    assert.equal(faixas.get('sem_sinal'), 1)
  })

  test('conta sem sinal pesa como atenção, não como saudável', async () => {
    // Desconhecido não pode afundar na lista: é sobre ela que não se sabe nada.
    await conta('desconhecida', { mrr: 1_000_000 })
    await conta('saudavel', { faixa: 'saudavel', mrr: 1_000_000 })
    const { contas } = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(contas[0]?.razaoSocial, 'desconhecida')
  })

  // ── Os quatro números ────────────────────────────────────────────────────

  test('os quatro números vêm calculados, e adesão sem base é nula', async () => {
    await conta('acme', { elegiveis: 800, ativas: 240, contratadas: 1000, atraso: 44 })
    const { contas } = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(contas[0]?.adesao30d, 240 / 800)
    assert.equal(contas[0]?.coberturaCadastral, 800 / 1000)
    assert.equal(contas[0]?.diasAtrasoMax, 44)

    await pool.query('UPDATE metrics.daily_snapshot SET vidas_elegiveis = 0')
    const depois = await carregarCarteira(pool, LIDER, { hoje: COMP })
    // Zero significaria "ninguém usou"; nulo, "não dá para saber".
    assert.equal(depois.contas[0]?.adesao30d, null)
  })

  test('snapshot parcial vem marcado — o número não é comparável', async () => {
    await conta('parcial', { completo: false })
    await conta('completa', { completo: true })
    const carteira = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(resumir(carteira).parciais, 1)
  })

  // ── Itens e cláusulas ────────────────────────────────────────────────────

  test('o item em modo sombra NÃO conta na carteira', async () => {
    // Ele não é trabalho de ninguém, e contá-lo faria a carteira parecer mais
    // carregada do que está.
    const c = await conta('acme', { faixa: 'risco' })
    for (const sombra of [true, false]) {
      await pool.query(
        `INSERT INTO success.work_item
           (account_id, gatilho, familia, prioridade, motivo, dono_email, prazo,
            modo_sombra, competencia)
         VALUES ($1,'G-01',$2,'alta','x',$3,$4::date + 3,$5,$4)`,
        [c, sombra ? 'sombra' : 'visivel', ANA.email, COMP, sombra],
      )
    }
    const { contas } = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(contas[0]?.itensAbertos, 1)
  })

  test('conta sem item aparece no resumo — é onde o próximo problema nasce', async () => {
    // O número que a fila não mostra: contas que não geraram trabalho hoje.
    await conta('quieta', { faixa: 'saudavel' })
    const carteira = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(resumir(carteira).semItem, 1)
  })

  test('cláusula proposta aparece como dado que ainda não decide', async () => {
    const c = await conta('acme')
    const doc = await pool.query<{ id: string }>(
      `INSERT INTO contracts.document (account_id,tipo,versao,titulo,status_assinatura,assinado_em)
       VALUES ($1,'contrato',1,'Contrato','assinado','2024-01-05') RETURNING id`,
      [c],
    )
    await pool.query(
      `INSERT INTO contracts.clause
         (account_id, tipo, valor_estruturado, valido_de, document_id, trecho, estado)
       VALUES ($1,'uso_marca','{"valor":"vedado"}'::jsonb,'2024-01-01',$2,'4.2','proposta')`,
      [c, doc.rows[0]!.id],
    )
    const carteira = await carregarCarteira(pool, LIDER, { hoje: COMP })
    assert.equal(carteira.contas[0]?.clausulasPropostas, 1)
    assert.equal(resumir(carteira).comClausulaProposta, 1)
  })

  // ── Recorte e filtro ─────────────────────────────────────────────────────

  test('o CSM vê a própria carteira', async () => {
    await conta('da-ana', { csm: ANA.email })
    await conta('do-bruno', { csm: BRUNO.email })
    const daAna = await carregarCarteira(pool, ANA, { hoje: COMP })
    assert.equal(daAna.contas.length, 1)
    assert.equal(daAna.visaoDaBase, false)
    assert.equal((await carregarCarteira(pool, LIDER, { hoje: COMP })).contas.length, 2)
  })

  test('autenticado sem grupo nenhum recebe carteira vazia', async () => {
    // Todo papel declarado enxerga contas — de propósito, porque qualquer área
    // precisa achar um cliente. Quem não enxerga é quem não está em grupo algum, e
    // é esse o caso do primeiro dia de alguém.
    await conta('acme')
    assert.equal(SEM_GRUPO.permissoes.contas, 'nenhum')
    assert.deepEqual((await carregarCarteira(pool, SEM_GRUPO, { hoje: COMP })).contas, [])
  })

  test('o filtro por faixa devolve só aquela faixa', async () => {
    await conta('critica', { faixa: 'critico' })
    await conta('saudavel', { faixa: 'saudavel' })
    const { contas } = await carregarCarteira(pool, LIDER, { hoje: COMP, faixa: 'critico' })
    assert.equal(contas.length, 1)
    assert.equal(contas[0]?.razaoSocial, 'critica')
  })

  // ── O resumo ─────────────────────────────────────────────────────────────

  test('o resumo soma o MRR e ordena as faixas da pior para a melhor', async () => {
    await conta('a', { faixa: 'saudavel', mrr: 1_000_000 })
    await conta('b', { faixa: 'critico', mrr: 2_000_000 })
    const r = resumir(await carregarCarteira(pool, LIDER, { hoje: COMP }))
    assert.equal(r.total, 2)
    assert.equal(r.mrrTotalCentavos, '3000000')
    assert.equal(r.porFaixa[0]?.faixa, 'critico', 'a pior primeiro')
  })
})
