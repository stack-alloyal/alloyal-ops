/**
 * O calendário contratual.
 *
 * O caso que domina este arquivo é a JANELA DE AVISO. É a data que a operação mais
 * esquece e a mais caroa, porque a mesma data tem duas consequências opostas: com
 * renovação automática, deixar passar prende por mais um ciclo; com renovação
 * expressa, perde o contrato por silêncio.
 *
 * E o resumo por mês tem uma aritmética própria: o MRR afetado é DISTINTO POR
 * CONTA. Uma conta com vencimento, janela de aviso e reajuste no mesmo mês afeta o
 * faturamento uma vez, não três — somar por data triplicaria o número que alguém
 * levaria para uma reunião.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@pulse/auth'
import pg from 'pg'

import {
  cumprirObrigacao,
  datasCriticas,
  dispensarObrigacao,
  HORIZONTE_MESES,
  ObrigacaoInvalidaError,
  resumirPorMes,
  vencerObrigacoes,
  type DataCritica,
} from './calendario.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const HOJE = '2026-07-31'

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const JURIDICO = quem('ju@alloyal.com.br', 'pulse-juridico')
const ANA = quem('ana@alloyal.com.br', 'pulse-csm')
const BRUNO = quem('bruno@alloyal.com.br', 'pulse-csm')

// ── O resumo por mês, sem banco ─────────────────────────────────────────────

const d = (p: Partial<DataCritica>): DataCritica => ({
  tipo: 'vencimento',
  accountId: 'c1',
  conta: 'Acme',
  data: '2026-08-10',
  dias: 10,
  descricao: 'x',
  mrrCentavos: '1000000',
  donoEmail: null,
  irreversivel: false,
  ...p,
})

test('o MRR afetado no mês conta cada conta UMA vez', () => {
  // Vencimento, janela de aviso e reajuste da mesma conta no mesmo mês afetam o
  // faturamento uma vez. Somar por data triplicaria o número.
  const [mes] = resumirPorMes([
    d({ tipo: 'vencimento' }),
    d({ tipo: 'janela_de_aviso', data: '2026-08-01' }),
    d({ tipo: 'reajuste', data: '2026-08-01' }),
  ])
  assert.equal(mes?.quantas, 3)
  assert.equal(mes?.mrrAfetadoCentavos, '1000000', 'uma conta, um MRR')
})

test('contas diferentes no mesmo mês somam', () => {
  const [mes] = resumirPorMes([
    d({ accountId: 'c1', mrrCentavos: '1000000' }),
    d({ accountId: 'c2', mrrCentavos: '2500000' }),
  ])
  assert.equal(mes?.mrrAfetadoCentavos, '3500000')
})

test('o resumo separa vencidas e irreversíveis', () => {
  const [mes] = resumirPorMes([
    d({ dias: -5 }),
    d({ accountId: 'c2', irreversivel: true }),
    d({ accountId: 'c3' }),
  ])
  assert.equal(mes?.vencidas, 1)
  assert.equal(mes?.irreversiveis, 1)
})

test('os meses saem em ordem', () => {
  const meses = resumirPorMes([
    d({ data: '2026-10-01' }),
    d({ data: '2026-08-01' }),
    d({ data: '2026-09-01' }),
  ]).map((m) => m.mes)
  assert.deepEqual(meses, ['2026-08', '2026-09', '2026-10'])
})

// ── Contra banco ────────────────────────────────────────────────────────────

describe('calendário contratual', { skip: !ADMIN }, () => {
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
      `TRUNCATE contracts.clause, contracts.obligation, contracts.event,
                contracts.approval, contracts.document, core.contract,
                core.account CASCADE`,
    )
  })

  async function conta(
    nome: string,
    opts: {
      diasParaVencer?: number
      mrr?: number
      avisoPrevio?: number
      reajusteMes?: number
      indice?: string
      renovacao?: string
      csm?: string
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
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas,
          aviso_previo_dias, reajuste_mes, reajuste_indice, renovacao, status_vigencia)
       VALUES ($1,$2,'2024-01-01',
               CASE WHEN $3::int IS NULL THEN NULL ELSE $4::date + $3::int END,
               1000,$5,$6,$7,$8,'vigente')`,
      [
        id,
        opts.mrr ?? 1_000_000,
        opts.diasParaVencer ?? null,
        HOJE,
        opts.avisoPrevio ?? 30,
        opts.reajusteMes ?? null,
        opts.indice ?? null,
        opts.renovacao ?? null,
      ],
    )
    return id
  }

  /** Grava a cláusula de aviso prévio já confirmada. */
  async function clausulaAviso(accountId: string, dias: number, estado = 'confirmada') {
    const doc = await pool.query<{ id: string }>(
      `INSERT INTO contracts.document (account_id, tipo, versao, titulo, status_assinatura, assinado_em)
       VALUES ($1,'contrato',1,'Contrato','assinado','2024-01-05') RETURNING id`,
      [accountId],
    )
    await pool.query(
      `INSERT INTO contracts.clause
         (account_id, tipo, valor_estruturado, valido_de, document_id, trecho,
          estado, confirmada_por, confirmada_em)
       VALUES ($1,'aviso_previo',$2::jsonb,'2024-01-01',$3,'9.3',$4,
               CASE WHEN $4='confirmada' THEN 'ju@alloyal.com.br' END,
               CASE WHEN $4='confirmada' THEN now() END)`,
      [accountId, JSON.stringify({ dias }), doc.rows[0]!.id, estado],
    )
  }

  // ── Vencimento e janela de aviso ─────────────────────────────────────────

  test('vencimento e janela de aviso aparecem como datas SEPARADAS', async () => {
    // "Vence em 90 dias" e "o cliente pode denunciar em 30" são duas conversas, e
    // a segunda é a que tem prazo.
    await conta('acme', { diasParaVencer: 90, avisoPrevio: 60 })
    const datas = await datasCriticas(pool, JURIDICO, { hoje: HOJE })
    const tipos = datas.map((x) => x.tipo)
    assert.ok(tipos.includes('vencimento'))
    assert.ok(tipos.includes('janela_de_aviso'))

    const janela = datas.find((x) => x.tipo === 'janela_de_aviso')!
    assert.equal(janela.dias, 30, '90 de vigência menos 60 de aviso')
  })

  test('a janela de aviso usa a CLÁUSULA confirmada, não o campo do contrato', async () => {
    // A cláusula é o dado com procedência; o campo é o que veio da planilha.
    const c = await conta('acme', { diasParaVencer: 120, avisoPrevio: 30 })
    await clausulaAviso(c, 90)
    const datas = await datasCriticas(pool, JURIDICO, { hoje: HOJE })
    const janela = datas.find((x) => x.tipo === 'janela_de_aviso')!
    assert.equal(janela.dias, 30, '120 menos os 90 da cláusula, não os 30 do campo')
    assert.equal(/sem cláusula confirmada/.test(janela.descricao), false)
  })

  test('cláusula PROPOSTA não move o prazo, e a descrição diz isso', async () => {
    // Cláusula proposta não decide nada. Um alerta calculado sobre valor não
    // conferido mandaria alguém agir com prazo errado.
    const c = await conta('acme', { diasParaVencer: 120, avisoPrevio: 30 })
    await clausulaAviso(c, 90, 'proposta')
    const janela = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'janela_de_aviso',
    )!
    assert.equal(janela.dias, 90, 'caiu de volta nos 30 dias do contrato')
    assert.match(janela.descricao, /sem cláusula confirmada/)
  })

  test('a janela de aviso é sempre irreversível', async () => {
    // Automática: passar prende por mais um ciclo. Expressa: perde por silêncio.
    // As duas são perda, e nenhuma se recupera depois da data.
    await conta('auto', { diasParaVencer: 60, avisoPrevio: 30, renovacao: 'automatica' })
    await conta('expressa', { diasParaVencer: 60, avisoPrevio: 30, renovacao: 'expressa' })
    const janelas = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).filter(
      (x) => x.tipo === 'janela_de_aviso',
    )
    assert.equal(janelas.length, 2)
    assert.ok(janelas.every((j) => j.irreversivel))
  })

  test('vencimento com renovação expressa é irreversível; automática não é', async () => {
    // Expressa: se ninguém agir, o contrato acaba. Automática: renova sozinho, e a
    // data é aviso e não emergência.
    await conta('expressa', { diasParaVencer: 40, renovacao: 'expressa' })
    await conta('auto', { diasParaVencer: 40, renovacao: 'automatica' })
    const venc = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).filter(
      (x) => x.tipo === 'vencimento',
    )
    const porConta = new Map(venc.map((v) => [v.conta, v.irreversivel]))
    assert.equal(porConta.get('expressa'), true)
    assert.equal(porConta.get('auto'), false)
  })

  test('a descrição do vencimento diz o modo de renovação', async () => {
    await conta('acme', { diasParaVencer: 40, renovacao: 'expressa' })
    const v = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'vencimento',
    )!
    assert.match(v.descricao, /expressa/)
  })

  // ── Reajuste ────────────────────────────────────────────────────────────

  test('reajuste aparece no mês configurado, dentro da janela', async () => {
    // Setembro está dentro dos 6 meses a partir de 31/07/2026.
    await conta('acme', { reajusteMes: 9, indice: 'IPCA' })
    const r = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'reajuste',
    )
    assert.ok(r, 'o reajuste de setembro entra')
    assert.match(r!.descricao, /IPCA/)
    assert.equal(r!.data, '2026-09-01')
  })

  test('reajuste não aplicado é perda composta, e vem marcado irreversível', async () => {
    // O ano seguinte reajusta sobre a base menor.
    await conta('acme', { reajusteMes: 9, indice: 'IGPM' })
    const r = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'reajuste',
    )!
    assert.equal(r.irreversivel, true)
  })

  test('índice não registrado aparece dito, não omitido', async () => {
    await conta('acme', { reajusteMes: 9 })
    const r = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'reajuste',
    )!
    assert.match(r.descricao, /índice não registrado/)
  })

  // ── Obrigações ──────────────────────────────────────────────────────────

  test('obrigação a vencer entra no calendário com o dono', async () => {
    const c = await conta('acme')
    await pool.query(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo, dono_interno)
       VALUES ($1,'alloyal','Entregar relatório trimestral',$2::date + 20,'impl@alloyal.com.br')`,
      [c, HOJE],
    )
    const o = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'obrigacao',
    )!
    assert.equal(o.donoEmail, 'impl@alloyal.com.br')
    assert.match(o.descricao, /Nossa obrigação/)
  })

  test('obrigação do cliente é rotulada como dele', async () => {
    // Quem tem que agir muda tudo: nossa obrigação é tarefa, obrigação do cliente
    // é cobrança.
    const c = await conta('acme')
    await pool.query(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo)
       VALUES ($1,'cliente','Manter a base atualizada',$2::date + 15)`,
      [c, HOJE],
    )
    const o = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'obrigacao',
    )!
    assert.match(o.descricao, /Obrigação do cliente/)
  })

  test('obrigação recorrente não entra no calendário de datas', async () => {
    // Ela não tem data: entra na cadência, e mostrá-la aqui poluiria a lista com
    // um item que nunca sai.
    const c = await conta('acme')
    await pool.query(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, recorrencia)
       VALUES ($1,'cliente','Atualizar a base','mensal')`,
      [c],
    )
    const datas = await datasCriticas(pool, JURIDICO, { hoje: HOJE })
    assert.equal(datas.filter((x) => x.tipo === 'obrigacao').length, 0)
  })

  test('cumprir registra quem e quando', async () => {
    const c = await conta('acme')
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo)
       VALUES ($1,'alloyal','x',$2::date + 5) RETURNING id`,
      [c, HOJE],
    )
    await cumprirObrigacao(pool, ANA, rows[0]!.id)
    const { rows: depois } = await pool.query<{ estado: string; cumprida_por: string }>(
      'SELECT estado, cumprida_por FROM contracts.obligation WHERE id = $1',
      [rows[0]!.id],
    )
    assert.equal(depois[0]?.estado, 'cumprida')
    assert.equal(depois[0]?.cumprida_por, ANA.email)
  })

  test('dispensar exige motivo escrito', async () => {
    // Sem motivo, dispensar viraria o caminho fácil e a lista de vencidas
    // esvaziaria sozinha.
    const c = await conta('acme')
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo)
       VALUES ($1,'alloyal','x',$2::date + 5) RETURNING id`,
      [c, HOJE],
    )
    await assert.rejects(
      () => dispensarObrigacao(pool, ANA, rows[0]!.id, '  '),
      ObrigacaoInvalidaError,
    )
    await dispensarObrigacao(pool, ANA, rows[0]!.id, 'extração leu errado o anexo II')
    const { rows: depois } = await pool.query<{ estado: string; descricao: string }>(
      'SELECT estado, descricao FROM contracts.obligation WHERE id = $1',
      [rows[0]!.id],
    )
    assert.equal(depois[0]?.estado, 'dispensada')
    assert.match(String(depois[0]?.descricao), /extração leu errado/)
  })

  test('vencer obrigações é estado gravado, não derivado na leitura', async () => {
    // A tela precisa distinguir "venceu e ninguém viu" de "venceu e alguém decidiu
    // deixar vencer", e as duas só se separam se o estado for gravado.
    const c = await conta('acme')
    await pool.query(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo)
       VALUES ($1,'alloyal','atrasada',$2::date - 3)`,
      [c, HOJE],
    )
    assert.equal(await vencerObrigacoes(pool, { hoje: HOJE }), 1)
    const { rows } = await pool.query<{ estado: string }>(
      'SELECT estado FROM contracts.obligation',
    )
    assert.equal(rows[0]?.estado, 'vencida')
    // E não vence de novo na segunda passada.
    assert.equal(await vencerObrigacoes(pool, { hoje: HOJE }), 0)
  })

  // ── Aditivo pendente ────────────────────────────────────────────────────

  test('aditivo enviado e não assinado aparece — o pior dos cinco', async () => {
    // As duas partes acham que vale, e não vale.
    const c = await conta('acme')
    await pool.query(
      `INSERT INTO contracts.document
         (account_id, tipo, versao, titulo, status_assinatura, carregado_por, criado_em)
         -- Ancorado em HOJE, nao em now(): a consulta recebe data fixa, e massa
         -- relativa ao relógio real fazia "40 dias" virar 39 na virada da meia-noite.
       VALUES ($1,'aditivo',1,'Aditivo 2 — ampliação de escopo','enviado','ju@alloyal.com.br',
               $2::date - interval '40 days')`,
      [c, HOJE],
    )
    const a = (await datasCriticas(pool, JURIDICO, { hoje: HOJE })).find(
      (x) => x.tipo === 'aditivo_pendente',
    )!
    assert.match(a.descricao, /Aditivo 2/)
    assert.match(a.descricao, /enviado há 40 dias/)
    // A data é HOJE: aditivo pendurado não é evento de um mês passado, é problema
    // de agora. Usar a data de criação o jogava num mês antigo e poluía o resumo
    // com um MRR "afetado" naquele mês que não afetou nada.
    assert.equal(a.data, HOJE)
    assert.equal(a.dias, 0)
    assert.equal(a.irreversivel, true, 'cada dia sem assinar é um dia sobre regra que não vale')
  })

  test('aditivo já assinado não aparece', async () => {
    const c = await conta('acme')
    await pool.query(
      `INSERT INTO contracts.document
         (account_id, tipo, versao, titulo, status_assinatura, assinado_em)
       VALUES ($1,'aditivo',1,'Aditivo 1','assinado','2025-08-15')`,
      [c],
    )
    const datas = await datasCriticas(pool, JURIDICO, { hoje: HOJE })
    assert.equal(datas.filter((x) => x.tipo === 'aditivo_pendente').length, 0)
  })

  // ── Recorte e ordem ─────────────────────────────────────────────────────

  test('o CSM vê só as datas da própria carteira', async () => {
    await conta('da-ana', { diasParaVencer: 40, csm: ANA.email })
    await conta('do-bruno', { diasParaVencer: 40, csm: BRUNO.email })
    const daAna = await datasCriticas(pool, ANA, { hoje: HOJE })
    assert.ok(daAna.every((x) => x.conta === 'da-ana'))
    assert.ok((await datasCriticas(pool, JURIDICO, { hoje: HOJE })).length > daAna.length)
  })

  test('a lista sai ordenada por data ENTRE tipos diferentes', async () => {
    // Ordenar cinco listas separadas em memória é como um vencimento de amanhã
    // aparece embaixo de uma obrigação de daqui a três meses.
    await conta('longe', { diasParaVencer: 150 })
    const c = await conta('perto')
    await pool.query(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo)
       VALUES ($1,'alloyal','obrigação de amanhã',$2::date + 1)`,
      [c, HOJE],
    )
    const datas = await datasCriticas(pool, JURIDICO, { hoje: HOJE })
    for (let i = 1; i < datas.length; i++) {
      assert.ok(datas[i - 1]!.data <= datas[i]!.data, 'fora de ordem')
    }
    assert.equal(datas[0]?.tipo, 'obrigacao', 'a de amanhã vem primeiro')
  })

  test('o horizonte padrão é de seis meses', async () => {
    assert.equal(HORIZONTE_MESES, 6)
    await conta('dentro', { diasParaVencer: 150 })
    await conta('fora', { diasParaVencer: 300 })
    const datas = await datasCriticas(pool, JURIDICO, { hoje: HOJE })
    assert.ok(datas.some((x) => x.conta === 'dentro'))
    assert.equal(
      datas.some((x) => x.conta === 'fora' && x.tipo === 'vencimento'),
      false,
    )
  })

  test('contrato já encerrado não gera data crítica', async () => {
    const c = await conta('saiu', { diasParaVencer: 40 })
    await pool.query(
      `UPDATE core.contract SET encerrado_em = $2::date - 10, status_vigencia = 'encerrado'
        WHERE account_id = $1`,
      [c, HOJE],
    )
    const datas = await datasCriticas(pool, JURIDICO, { hoje: HOJE })
    assert.equal(datas.filter((x) => x.conta === 'saiu').length, 0)
  })
})
