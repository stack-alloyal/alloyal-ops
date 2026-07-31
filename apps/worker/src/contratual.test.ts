/**
 * Datas contratuais virando item de trabalho.
 *
 * O que se testa aqui é sobretudo que este gerador NÃO tem regras próprias: ele
 * passa pelo mesmo caminho da fila e por isso herda teto, dedup, carência e modo
 * sombra. Um gerador com regras próprias furaria o teto de alguém na primeira
 * semana, e ninguém perceberia até um CSM reclamar de 30 itens.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import pg from 'pg'

import {
  avaliarDatasContratuais,
  mereceItem,
  prazoDaData,
  prioridadeDaData,
} from './contratual.js'
import { FLAG_GATILHO, TETO_POR_PESSOA } from './fila.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const COMP = '2026-07-31'
const AGORA = new Date('2026-07-31T09:00:00Z')
const CSM = 'ana@alloyal.com.br'

// ── A prioridade, sem banco ─────────────────────────────────────────────────

const d = (p: { dias: number; irreversivel: boolean }) =>
  ({
    tipo: 'janela_de_aviso' as const,
    accountId: 'c1',
    conta: 'Acme',
    data: '2026-08-10',
    descricao: 'x',
    mrrCentavos: '1000000',
    donoEmail: CSM,
    ...p,
  }) as Parameters<typeof prioridadeDaData>[0]

test('a prioridade sai do que se PERDE, não do tipo da data', () => {
  // Classificar por tipo faria toda obrigação parecer tão urgente quanto uma
  // janela de aviso fechando amanhã.
  assert.equal(prioridadeDaData(d({ dias: 5, irreversivel: true })), 'critica')
  assert.equal(prioridadeDaData(d({ dias: 30, irreversivel: true })), 'alta')
  assert.equal(prioridadeDaData(d({ dias: 100, irreversivel: true })), 'media')
  assert.equal(prioridadeDaData(d({ dias: 5, irreversivel: false })), 'alta')
  assert.equal(prioridadeDaData(d({ dias: 60, irreversivel: false })), 'media')
})

test('data já passada é crítica quando irreversível', () => {
  assert.equal(prioridadeDaData(d({ dias: -3, irreversivel: true })), 'critica')
  assert.equal(prioridadeDaData(d({ dias: -3, irreversivel: false })), 'alta')
})

test('o prazo nunca é negativo — item nasce vencido, não com prazo impossível', () => {
  assert.equal(prazoDaData(d({ dias: 12, irreversivel: true })), 12)
  assert.equal(prazoDaData(d({ dias: -40, irreversivel: true })), 0)
})

test('data longe não merece item — ela pertence ao calendário', () => {
  // A primeira rodada contra a massa real gerou 54 itens de reajuste para 120
  // contas. Enchente por construção, num produto cujo orçamento é 12 por pessoa.
  assert.equal(mereceItem(d({ dias: 20, irreversivel: true }), 45), true)
  assert.equal(mereceItem(d({ dias: 150, irreversivel: true }), 45), false)
})

test('data VENCIDA sempre merece item, por longe que a regra seja', () => {
  // Data crítica vencida é o pior caso; o item nasce vencido para aparecer no topo.
  assert.equal(mereceItem(d({ dias: -1, irreversivel: false }), 15), true)
})

test('antecedência nula significa sempre — só o aditivo pendurado', () => {
  assert.equal(mereceItem(d({ dias: 999, irreversivel: false }), null), true)
})

// ── Contra banco ────────────────────────────────────────────────────────────

describe('itens de datas contratuais', { skip: !ADMIN }, () => {
  let pool: pg.Pool

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
      `TRUNCATE success.work_item, success.playbook, contracts.clause,
                contracts.obligation, contracts.document, core.contract,
                core.account CASCADE`,
    )
    await pool.query(`DELETE FROM ops.feature_flag WHERE chave LIKE '${FLAG_GATILHO}%'`)
  })

  async function promover(...gatilhos: string[]) {
    for (const g of gatilhos) {
      await pool.query(
        `INSERT INTO ops.feature_flag (chave, habilitado) VALUES ($1, true)
         ON CONFLICT (chave) DO UPDATE SET habilitado = true`,
        [`${FLAG_GATILHO}${g}`],
      )
    }
  }

  async function conta(
    nome: string,
    opts: { diasParaVencer?: number; avisoPrevio?: number; renovacao?: string; csm?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ($1,'medio','industria',$2,$3) RETURNING id`,
      [nome, `b-${nome}`, opts.csm ?? CSM],
    )
    const id = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas,
          aviso_previo_dias, renovacao, status_vigencia)
       VALUES ($1, 1000000, '2024-01-01', $2::date + $3::int, 1000, $4, $5, 'vigente')`,
      [id, COMP, opts.diasParaVencer ?? 60, opts.avisoPrevio ?? 30, opts.renovacao ?? 'expressa'],
    )
    return id
  }

  // ── Modo sombra, herdado ──────────────────────────────────────────────────

  test('gatilho contratual nasce em modo sombra, como qualquer outro', async () => {
    // Nada vai direto à fila do time — inclusive o que vem de contrato.
    await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.ok(r.criados > 0)
    assert.equal(r.criados, r.emSombra)
    const { rows } = await pool.query<{ modo_sombra: boolean }>(
      'SELECT DISTINCT modo_sombra FROM success.work_item',
    )
    assert.deepEqual(
      rows.map((x) => x.modo_sombra),
      [true],
    )
  })

  test('promovido, chega à fila do time', async () => {
    await promover('C-01', 'C-02')
    await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.equal(r.emSombra, 0)
    assert.ok(r.criados > 0)
  })

  // ── Dedup: uma conversa, um item ──────────────────────────────────────────

  test('janela de aviso e vencimento geram UM item, não dois', async () => {
    // São a mesma conversa com o cliente; dois itens fariam o CSM ligar duas vezes
    // para dizer a mesma coisa.
    await promover('C-01', 'C-02')
    await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })

    const { rows } = await pool.query<{ familia: string; n: string }>(
      `SELECT familia, count(*) n FROM success.work_item GROUP BY familia`,
    )
    const renovacao = rows.find((x) => x.familia === 'renovacao')
    assert.equal(renovacao?.n, '1', 'uma família, um item')
    assert.equal(r.atualizados, 1, 'a segunda data atualizou a evidência da primeira')
  })

  test('reavaliar no dia seguinte não duplica', async () => {
    await promover('C-01')
    await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    const segunda = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.equal(segunda.criados, 0)
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) n FROM success.work_item')
    assert.equal(rows[0]?.n, '1')
  })

  // ── Teto, herdado ─────────────────────────────────────────────────────────

  test('o teto por pessoa vale para item contratual também', async () => {
    // É o ponto do arquivo: um gerador com regras próprias furaria o teto e
    // ninguém perceberia até um CSM reclamar de 30 itens.
    await promover('C-01', 'C-02')
    for (let i = 0; i < TETO_POR_PESSOA + 4; i++) {
      await conta(`c${i}`, { diasParaVencer: 40 + i, avisoPrevio: 30 })
    }
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.ok(r.emBacklog > 0, 'o excedente foi para backlog')

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM success.work_item
        WHERE dono_email = $1 AND estado = 'aberto' AND NOT modo_sombra`,
      [CSM],
    )
    assert.equal(Number(rows[0]?.n), TETO_POR_PESSOA)
  })

  test('o teto conta a fila JÁ existente, não só a desta rodada', async () => {
    // Senão a fila de sinais e a de contrato somariam 24 itens para a mesma pessoa.
    await promover('C-01')
    const c = await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    for (let i = 0; i < TETO_POR_PESSOA; i++) {
      await pool.query(
        `INSERT INTO success.work_item
           (account_id, gatilho, familia, prioridade, motivo, dono_email, prazo,
            modo_sombra, competencia)
         VALUES ($1,'G-01',$2,'alta','de sinal',$3,$4::date + 3,false,$4)`,
        [c, `sinal-${i}`, CSM, COMP],
      )
    }
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.equal(r.criados, r.emBacklog, 'tudo foi para backlog: o teto já estava cheio')
  })

  // ── Carência ──────────────────────────────────────────────────────────────

  test('obrigação fechada há pouco não reabre', async () => {
    await promover('C-04')
    const c = await conta('acme', { diasParaVencer: 200 })
    await pool.query(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo, dono_interno)
       VALUES ($1,'alloyal','Relatório trimestral',$2::date + 10,$3)`,
      [c, COMP, CSM],
    )
    await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    await pool.query(
      `UPDATE success.work_item SET estado='fechado', desfecho='resolvido',
              fechado_em=$1, fechado_por=$2 WHERE familia='obrigacao'`,
      [new Date(AGORA.getTime() - 5 * 86_400_000), CSM],
    )
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.equal(r.bloqueadosPorCarencia, 1)
  })

  // ── Sem dono ──────────────────────────────────────────────────────────────

  test('conta sem CSM não gera item, e o número aparece', async () => {
    // Item sem responsável é lista, e lista não é fila. O contador existe para
    // alguém corrigir a carteira.
    await promover('C-01', 'C-02')
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id)
       VALUES ('sem csm','medio','industria','b-sem') RETURNING id`,
    )
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas,
          aviso_previo_dias, status_vigencia)
       VALUES ($1,1000000,'2024-01-01',$2::date + 40,1000,30,'vigente')`,
      [rows[0]!.id, COMP],
    )
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.equal(r.criados, 0)
    assert.ok(r.semDono >= 2, 'vencimento e janela de aviso, os dois sem dono')
  })

  // ── O conteúdo do item ────────────────────────────────────────────────────

  test('o item carrega a data e o que se perde, na evidência', async () => {
    // A evidência é o que permite auditar por que o item nasceu com aquela
    // prioridade três meses depois.
    await promover('C-01')
    await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    await avaliarDatasContratuais(pool, COMP, { agora: AGORA })

    const { rows } = await pool.query<{ evidencia: Record<string, unknown>; motivo: string }>(
      `SELECT evidencia, motivo FROM success.work_item WHERE familia='renovacao'`,
    )
    const e = rows[0]!.evidencia
    assert.ok(typeof e['tipo_data'] === 'string')
    assert.ok(typeof e['data'] === 'string')
    assert.equal(e['irreversivel'], true)
    assert.match(rows[0]!.motivo, /\d/, 'o motivo traz número, como todo motivo da fila')
  })

  test('o gatilho tem prefixo C-, para a origem ser óbvia na fila', async () => {
    // Quem olha um item sabe se ele veio de sinal de uso ou de cláusula.
    await promover('C-01', 'C-02')
    await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    const { rows } = await pool.query<{ gatilho: string }>(
      'SELECT DISTINCT gatilho FROM success.work_item',
    )
    assert.ok(rows.every((r) => r.gatilho.startsWith('C-')))
  })

  test('contrato encerrado não gera item', async () => {
    await promover('C-01', 'C-02')
    const c = await conta('saiu', { diasParaVencer: 40 })
    await pool.query(
      `UPDATE core.contract SET encerrado_em = $2::date - 5, status_vigencia = 'encerrado'
        WHERE account_id = $1`,
      [c, COMP],
    )
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.equal(r.criados, 0)
  })

  test('a dedup preserva o motivo da data MAIS urgente', async () => {
    // A janela de aviso (10 dias) cria o item; o vencimento (40 dias) reavalia
    // depois. Sem guarda, o texto passava a mostrar o prazo folgado e escondia o
    // apertado — o CSM leria "vigência acaba em 40 dias" quando o cliente já pode
    // denunciar em 10.
    await promover('C-01', 'C-02')
    await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    await avaliarDatasContratuais(pool, COMP, { agora: AGORA })

    const { rows } = await pool.query<{ motivo: string; gatilho: string; prioridade: string }>(
      `SELECT motivo, gatilho, prioridade FROM success.work_item WHERE familia='renovacao'`,
    )
    assert.equal(rows.length, 1)
    assert.match(rows[0]!.motivo, /denunciar em 10 dias/, 'o prazo apertado, não o folgado')
    assert.equal(rows[0]!.gatilho, 'C-01')
    assert.equal(rows[0]!.prioridade, 'critica')
  })

  test('toda descrição que vira motivo carrega número', async () => {
    // Mesma regra dos 14 gatilhos: "vigência acaba" sem prazo informa e não
    // instrui, igual a "score caiu".
    await promover('C-01', 'C-02', 'C-03', 'C-04')
    const c = await conta('acme', { diasParaVencer: 40, avisoPrevio: 30 })
    await pool.query(
      `UPDATE core.contract SET reajuste_mes = 9, reajuste_indice = 'IPCA'
        WHERE account_id = $1`,
      [c],
    )
    await pool.query(
      `INSERT INTO contracts.obligation (account_id, parte, descricao, prazo, dono_interno)
       VALUES ($1,'alloyal','Relatório trimestral de uso',$2::date + 20,$3)`,
      [c, COMP, CSM],
    )
    await avaliarDatasContratuais(pool, COMP, { agora: AGORA })

    const { rows } = await pool.query<{ motivo: string; familia: string }>(
      'SELECT motivo, familia FROM success.work_item',
    )
    assert.ok(rows.length >= 3)
    for (const r of rows) {
      assert.match(r.motivo, /\d/, `${r.familia}: motivo sem número`)
    }
  })

  test('reajuste longe fica só no calendário, e o número aparece no resumo', async () => {
    // Silêncio sobre o que foi cortado leria como "cobrimos tudo". O contador diz
    // quantas datas reais ficaram fora da fila de propósito.
    await promover('C-03')
    const c = await conta('acme', { diasParaVencer: 300 })
    // Reajuste em janeiro: a ~5 meses de 31/07, dentro do calendário e fora da fila.
    await pool.query(
      `UPDATE core.contract SET reajuste_mes = 1, reajuste_indice = 'IPCA'
        WHERE account_id = $1`,
      [c],
    )
    const r = await avaliarDatasContratuais(pool, COMP, { agora: AGORA })
    assert.equal(r.criados, 0)
    assert.ok(r.longeParaItem >= 1, 'a data existe, e ficou no calendário')
  })
})
