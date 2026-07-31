/**
 * O recorte da fila, contra Postgres real.
 *
 * As asserções aqui são majoritariamente sobre o que NÃO aparece: item de outra
 * carteira, item em modo sombra, item já fechado. É a classe de erro que passa
 * numa revisão de tela — a tela fica bonita e mostra demais.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@pulse/auth'
import pg from 'pg'

import { carregarFila, fecharItem, NaoEhSeuError, vePelaSombra } from './fila.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const COMP = '2026-07-30'
const HOJE = new Date('2026-07-30T09:00:00Z')

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const ANA = quem('ana@alloyal.com.br', 'pulse-csm')
const BRUNO = quem('bruno@alloyal.com.br', 'pulse-csm')
const LIDER = quem('lider@alloyal.com.br', 'pulse-cs-lead')

describe('recorte da fila', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  async function conta(nome: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ($1,'medio','industria',$2,'ana@alloyal.com.br') RETURNING id`,
      [nome, `b-${nome}`],
    )
    const id = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas, status_vigencia)
       VALUES ($1, 1500000, $2::date - 400, $2::date + 300, 1000, 'vigente')`,
      [id, COMP],
    )
    return id
  }

  async function item(opts: {
    conta: string
    dono: string
    prioridade?: string
    familia?: string
    prazoEmDias?: number
    sombra?: boolean
    estado?: string
    motivo?: string
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO success.work_item
         (account_id, gatilho, familia, prioridade, motivo, dono_email, prazo,
          estado, modo_sombra, competencia)
       VALUES ($1,'G-01',$2,$3,$4,$5,$6::date + $7::int,$8,$9,$6)
       RETURNING id`,
      [
        opts.conta,
        opts.familia ?? 'financeiro',
        opts.prioridade ?? 'alta',
        opts.motivo ?? 'atraso de 40 dias · R$ 5.000 em aberto',
        opts.dono,
        COMP,
        opts.prazoEmDias ?? 3,
        opts.estado ?? 'aberto',
        opts.sombra ?? false,
      ],
    )
    return String(rows[0]!.id)
  }

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
      'TRUNCATE success.work_item, success.playbook, core.contract, core.account CASCADE',
    )
  })

  // ── O recorte por carteira ────────────────────────────────────────────────

  test('o CSM vê a própria carteira e não a do colega', async () => {
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email })
    await item({ conta: c, dono: BRUNO.email, familia: 'adesao' })

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.equal(f.abertos.length, 1)
    assert.equal(f.abertos[0]?.donoEmail, ANA.email)
    assert.equal(f.visaoDaBase, false)
  })

  test('a liderança vê a fila da base inteira', async () => {
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email })
    await item({ conta: c, dono: BRUNO.email, familia: 'adesao' })

    const f = await carregarFila(pool, LIDER, { hoje: HOJE })
    assert.equal(f.abertos.length, 2)
    assert.equal(f.visaoDaBase, true)
  })

  // ── Modo sombra ───────────────────────────────────────────────────────────

  test('item em modo sombra é invisível para o CSM', async () => {
    // Se o CSM vir, o experimento acabou: ou ele age (e o gatilho nunca é medido
    // em repouso), ou aprende que parte da fila é para ignorar.
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email, sombra: true })

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.deepEqual(f.abertos, [])
    assert.deepEqual(f.sombra, [], 'nem sequer na lista de sombra')
  })

  test('a liderança vê o modo sombra, separado do que é trabalho', async () => {
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email, sombra: true })
    await item({ conta: c, dono: ANA.email, sombra: false, familia: 'adesao' })

    const f = await carregarFila(pool, LIDER, { hoje: HOJE })
    assert.equal(f.sombra.length, 1)
    assert.equal(f.abertos.length, 1)
    assert.equal(f.abertos[0]?.modoSombra, false, 'sombra não vaza para o trabalho')
  })

  test('quem aprova a promoção é quem enxerga a sombra', () => {
    assert.equal(vePelaSombra(ANA), false)
    assert.equal(vePelaSombra(LIDER), true)
  })

  // ── Backlog ───────────────────────────────────────────────────────────────

  test('o backlog vem separado do que está no teto', async () => {
    // Misturar os dois é como uma fila de 12 vira uma lista de 40.
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email })
    await item({ conta: c, dono: ANA.email, estado: 'backlog', familia: 'adesao' })

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.equal(f.abertos.length, 1)
    assert.equal(f.backlog.length, 1)
  })

  test('item fechado sai da fila', async () => {
    const c = await conta('acme')
    const id = await item({ conta: c, dono: ANA.email })
    await fecharItem(pool, ANA, id, 'resolvido')

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.deepEqual(f.abertos, [])
  })

  // ── A ordem: a primeira linha é a primeira ação ───────────────────────────

  test('vencido vem antes de crítico que ainda tem prazo', async () => {
    // O aceite é "três CSMs identificam a primeira ação em menos de 10 segundos".
    // Isso só vale se a primeira linha for a primeira ação, sem comparar duas.
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email, prioridade: 'critica', prazoEmDias: 2, familia: 'adesao' })
    await item({ conta: c, dono: ANA.email, prioridade: 'media', prazoEmDias: -4, familia: 'financeiro' })

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.equal(f.abertos[0]?.familia, 'financeiro', 'o vencido vem primeiro')
    assert.equal(f.abertos[0]?.diasParaPrazo, -4)
  })

  test('empate em prioridade e prazo desempata pelo MRR, não pelo alfabeto', async () => {
    // Quatro contas entrando em provisão no mesmo dia é comum. O que separa é
    // quanto está em jogo — e por nome a de R$ 1.673 viria antes da de R$ 17.531.
    const pequena = await conta('zeta pequena')
    const grande = await conta('alfa grande')
    await pool.query('UPDATE core.contract SET mrr_centavos = 170000 WHERE account_id = $1', [pequena])
    await pool.query('UPDATE core.contract SET mrr_centavos = 1750000 WHERE account_id = $1', [grande])
    await item({ conta: pequena, dono: ANA.email, prioridade: 'critica', prazoEmDias: 1 })
    await item({ conta: grande, dono: ANA.email, prioridade: 'critica', prazoEmDias: 1 })

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.deepEqual(
      f.abertos.map((i) => i.conta),
      ['alfa grande', 'zeta pequena'],
    )
  })

  test('entre itens no prazo, a prioridade decide', async () => {
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email, prioridade: 'media', prazoEmDias: 1, familia: 'adesao' })
    await item({ conta: c, dono: ANA.email, prioridade: 'critica', prazoEmDias: 5, familia: 'financeiro' })

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.deepEqual(
      f.abertos.map((i) => i.prioridade),
      ['critica', 'media'],
    )
  })

  // ── Fechar ────────────────────────────────────────────────────────────────

  test('fechar exige desfecho e registra quem fechou', async () => {
    const c = await conta('acme')
    const id = await item({ conta: c, dono: ANA.email })
    await fecharItem(pool, ANA, id, 'falso_positivo', 'o atraso já tinha sido pago')

    const { rows } = await pool.query<{
      estado: string
      desfecho: string
      fechado_por: string
      desfecho_nota: string
    }>('SELECT estado, desfecho, fechado_por, desfecho_nota FROM success.work_item WHERE id=$1', [id])
    assert.equal(rows[0]?.estado, 'fechado')
    assert.equal(rows[0]?.desfecho, 'falso_positivo')
    assert.equal(rows[0]?.fechado_por, ANA.email)
    assert.match(String(rows[0]?.desfecho_nota), /já tinha sido pago/)
  })

  test('ninguém fecha item de outra carteira', async () => {
    const c = await conta('acme')
    const id = await item({ conta: c, dono: ANA.email })
    await assert.rejects(() => fecharItem(pool, BRUNO, id, 'resolvido'), NaoEhSeuError)

    const { rows } = await pool.query<{ estado: string }>(
      'SELECT estado FROM success.work_item WHERE id=$1',
      [id],
    )
    assert.equal(rows[0]?.estado, 'aberto', 'o item continua aberto para quem é dono')
  })

  test('fechar duas vezes não sobrescreve o primeiro desfecho', async () => {
    // Sem isso, um duplo clique troca "falso positivo" por "resolvido" e a
    // calibração do gatilho perde justamente o sinal que interessa.
    const c = await conta('acme')
    const id = await item({ conta: c, dono: ANA.email })
    await fecharItem(pool, ANA, id, 'falso_positivo')
    await assert.rejects(() => fecharItem(pool, ANA, id, 'resolvido'), NaoEhSeuError)

    const { rows } = await pool.query<{ desfecho: string }>(
      'SELECT desfecho FROM success.work_item WHERE id=$1',
      [id],
    )
    assert.equal(rows[0]?.desfecho, 'falso_positivo')
  })

  // ── Contexto que a linha carrega ──────────────────────────────────────────

  test('a linha traz o motivo com número e o MRR da conta', async () => {
    // Sem MRR na linha, "qual destes dois eu faço primeiro" fica sem resposta.
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email })

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.match(f.abertos[0]!.motivo, /\d/)
    assert.equal(f.abertos[0]?.mrrCentavos, '1500000')
    assert.equal(f.abertos[0]?.conta, 'acme')
  })

  test('quem não tem escopo de fila não recebe consulta nenhuma', async () => {
    const c = await conta('acme')
    await item({ conta: c, dono: ANA.email })
    const comercial = quem('ju@alloyal.com.br', 'pulse-comercial')
    assert.equal(comercial.permissoes.fila, 'nenhum')

    const f = await carregarFila(pool, comercial, { hoje: HOJE })
    assert.deepEqual(f.abertos, [])
  })

  test('a linha da fila traz o playbook que valia quando o item nasceu', async () => {
    // Publicar a versão 2 depois não pode mudar o que este item mostra: a
    // pergunta "o CSM seguiu o processo?" só tem resposta se o processo exibido
    // for o daquele momento.
    const c = await conta('acme')
    const { rows: v1 } = await pool.query<{ id: string }>(
      `INSERT INTO success.playbook (chave, versao, titulo, conteudo, gatilhos, ativo,
                                     publicado_por, publicado_em)
       VALUES ('cobranca-30d', 1, 'Processo da versão 1',
               'Texto suficientemente longo para passar pela validação do módulo de biblioteca.',
               ARRAY['G-01'], true, 'lead@alloyal.com.br', now())
       RETURNING id`,
    )
    await pool.query(
      `INSERT INTO success.work_item
         (account_id, gatilho, familia, prioridade, motivo, dono_email, prazo,
          modo_sombra, competencia, playbook_id)
       VALUES ($1,'G-01','financeiro','alta','atraso de 40 dias',$2,$3::date + 3,false,$3,$4)`,
      [c, ANA.email, COMP, v1[0]!.id],
    )

    // A versão 2 entra e aposenta a 1.
    await pool.query(`UPDATE success.playbook SET ativo = false, substituido_em = now()`)
    await pool.query(
      `INSERT INTO success.playbook (chave, versao, titulo, conteudo, gatilhos, ativo,
                                     publicado_por, publicado_em)
       VALUES ('cobranca-30d', 2, 'Processo da versão 2',
               'Outro texto suficientemente longo para passar pela validação do módulo.',
               ARRAY['G-01'], true, 'lead@alloyal.com.br', now())`,
    )

    const f = await carregarFila(pool, ANA, { hoje: HOJE })
    assert.equal(f.abertos[0]?.playbookTitulo, 'Processo da versão 1')
  })
})
