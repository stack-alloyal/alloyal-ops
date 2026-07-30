/**
 * Churn real — as quatro datas.
 *
 * O exemplo que o PRD usa vira teste literal: levantada em 15/jul com 90 dias
 * de aviso entra no churn de CONTAS de julho e no churn de RECEITA de novembro.
 * Se algum dia esses dois números colapsarem num só, é aqui que se descobre.
 *
 * O resto do arquivo é sobre RECUSA. Errar o último mês de cobrança move receita
 * entre competências depois de a anterior estar congelada — e competência
 * congelada não se corrige, só se ajusta na corrente, com nota.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@ops/auth'
import pg from 'pg'

import {
  anunciar,
  competenciaDeEfeito,
  confirmarAviso,
  confirmarUltimaCobranca,
  encerrar,
  faltaParaEncerrar,
  fimDoAviso,
  listarSaidas,
  podeIr,
  resumoChurn,
  MOTIVOS_SAIDA,
  reter,
  rotuloDoMotivo,
  SemPermissaoError,
  TransicaoInvalidaError,
  type Saida,
} from './cancelamento.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const CSM = quem('ana@alloyal.com.br', 'ops-csm')
const LIDER = quem('lider@alloyal.com.br', 'ops-cs-lead')
const FIN = quem('fin@alloyal.com.br', 'ops-financeiro')

// ── As funções puras ────────────────────────────────────────────────────────

test('a competência de efeito é sempre o mês seguinte à última cobrança', () => {
  assert.equal(competenciaDeEfeito('2026-10-01'), '2026-11-01')
  assert.equal(competenciaDeEfeito('2026-12-01'), '2027-01-01', 'vira o ano')
  assert.equal(competenciaDeEfeito('2026-01-01'), '2026-02-01')
})

test('o fim do aviso é a levantada mais os dias do contrato', () => {
  // O exemplo do PRD: 15/jul + 90 dias = 13/out.
  assert.equal(fimDoAviso('2026-07-15', 90), '2026-10-13')
  assert.equal(fimDoAviso('2026-07-15', 30), '2026-08-14')
  assert.equal(fimDoAviso('2026-02-27', 3), '2026-03-02', 'atravessa o fim do mês')
})

test('retido e encerrado são terminais', () => {
  // Reabrir moveria receita entre competências já congeladas. Se o cliente
  // voltar, o evento certo é uma reativação nova.
  assert.equal(podeIr('anunciado', 'em_aviso'), true)
  assert.equal(podeIr('anunciado', 'retido'), true)
  assert.equal(podeIr('em_aviso', 'encerrado'), true)
  assert.equal(podeIr('retido', 'em_aviso'), false)
  assert.equal(podeIr('encerrado', 'em_aviso'), false)
})

test('o que falta para encerrar vem como lista, não como "não pode"', () => {
  // Sem a lista, um distrato fica parado três semanas até alguém descobrir qual
  // campo estava em branco.
  const vazia = {
    avisoConfirmadoPor: null,
    competenciaUltimaCobranca: null,
    cobrancaConfirmadaPor: null,
    aprovadoPor: null,
  } as unknown as Saida
  const falta = faltaParaEncerrar(vazia)
  assert.equal(falta.length, 3)
  assert.ok(falta.some((f) => /aviso prévio/.test(f)))
  assert.ok(falta.some((f) => /Financeiro/.test(f)))
  assert.ok(falta.some((f) => /aprovação/.test(f)))
})

// ── Contra banco ────────────────────────────────────────────────────────────

describe('fluxo de saída', { skip: !ADMIN }, () => {
  let pool: pg.Pool
  let acme: string

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
      `TRUNCATE success.cancellation, fact.mrr_event, metrics.daily_snapshot,
                core.contract, core.account CASCADE`,
    )
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ('Acme','medio','industria','b-acme',$1) RETURNING id`,
      [CSM.email],
    )
    acme = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas,
          aviso_previo_dias, status_vigencia)
       VALUES ($1, 4000000, '2024-01-01', '2027-01-01', 1000, 90, 'vigente')`,
      [acme],
    )
  })

  /** O caminho completo do exemplo do PRD. */
  async function ateEncerrar(): Promise<string> {
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
      canal: 'reuniao',
      quemComunicou: 'diretor de RH',
      motivo: 'custo',
    })
    await confirmarAviso(pool, CSM, id, 90)
    await confirmarUltimaCobranca(pool, FIN, id, '2026-10')
    await encerrar(pool, FIN, id)
    return id
  }

  // ── O exemplo do PRD, literal ─────────────────────────────────────────────

  test('levantada em 15/jul com 90 dias: contas em JULHO, receita em NOVEMBRO', async () => {
    const id = await ateEncerrar()
    const [s] = await listarSaidas(pool, LIDER)
    assert.equal(s?.id, id)
    assert.equal(s?.dataLevantada, '2026-07-15')
    assert.equal(s?.dataFimAviso, '2026-10-13', 'a retenção tem até aqui')
    assert.equal(s?.competenciaUltimaCobranca, '2026-10')
    assert.equal(s?.competenciaEfeitoReceita, '2026-11')

    const julho = await resumoChurn(pool, '2026-07-01')
    assert.equal(julho.contasQueLevantaram, 1, 'a conta sai em julho')
    assert.equal(julho.contasComEfeito, 0, 'a receita ainda não')
    assert.equal(
      julho.mrrComprometidoCentavos,
      '4000000',
      'saída comprometida, e o número de julho não muda por a saída já estar encerrada hoje',
    )

    const novembro = await resumoChurn(pool, '2026-11-01')
    assert.equal(novembro.contasQueLevantaram, 0)
    assert.equal(novembro.contasComEfeito, 1, 'a receita sai em novembro')
    assert.equal(novembro.mrrRealizadoCentavos, '4000000')
  })

  test('durante o aviso o MRR é comprometido, e não perda realizada', async () => {
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await confirmarAviso(pool, CSM, id, 90)
    await confirmarUltimaCobranca(pool, FIN, id, '2026-10')

    for (const mes of ['2026-08-01', '2026-09-01', '2026-10-01']) {
      const r = await resumoChurn(pool, mes)
      assert.equal(r.mrrComprometidoCentavos, '4000000', `${mes}: ainda faturando`)
      assert.equal(r.mrrRealizadoCentavos, '0', `${mes}: a receita ainda não saiu`)
    }
  })

  // ── As duas confirmações ──────────────────────────────────────────────────

  test('sem a confirmação do aviso, a competência de efeito não é gravada', async () => {
    // É a invariante central: o banco recusa, e o módulo recusa antes com uma
    // frase que uma pessoa entende.
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await confirmarUltimaCobranca(pool, FIN, id, '2026-10')

    const [s] = await listarSaidas(pool, LIDER)
    assert.equal(s?.competenciaUltimaCobranca, '2026-10')
    assert.equal(s?.competenciaEfeitoReceita, null, 'falta a outra confirmação')
  })

  test('encerrar sem as duas confirmações diz exatamente o que falta', async () => {
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await assert.rejects(
      () => encerrar(pool, FIN, id),
      (e: Error) => {
        assert.ok(e instanceof TransicaoInvalidaError)
        assert.match(e.message, /aviso prévio/)
        assert.match(e.message, /Financeiro/)
        return true
      },
    )
  })

  test('só o Financeiro confirma o último mês de cobrança', async () => {
    // O CSM não sabe se a fatura saiu, foi rateada ou antecipada.
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await assert.rejects(
      () => confirmarUltimaCobranca(pool, CSM, id, '2026-10'),
      SemPermissaoError,
    )
  })

  test('o aviso confirmado move a saída para em_aviso e recalcula o prazo', async () => {
    // O contrato diz 90, mas houve acordo de 60: é o campo que mais desloca
    // receita entre meses, e por isso é pessoa que confirma.
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await confirmarAviso(pool, CSM, id, 60)
    const [s] = await listarSaidas(pool, LIDER)
    assert.equal(s?.estado, 'em_aviso')
    assert.equal(s?.avisoPrevioDias, 60)
    assert.equal(s?.dataFimAviso, '2026-09-13')
    assert.equal(s?.avisoConfirmadoPor, CSM.email)
  })

  // ── Congelamento no anúncio ───────────────────────────────────────────────

  test('o MRR é congelado na levantada e não segue o reajuste do contrato', async () => {
    // A perda tem que ser medida contra o valor que existia quando o cliente
    // decidiu sair — senão um reajuste durante o aviso mudaria o churn passado.
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await pool.query('UPDATE core.contract SET mrr_centavos = 9900000 WHERE account_id = $1', [acme])

    const [s] = await listarSaidas(pool, LIDER)
    assert.equal(s?.mrrCentavosNaLevantada, '4000000')
    await confirmarAviso(pool, CSM, id, 90)
    await confirmarUltimaCobranca(pool, FIN, id, '2026-10')
    const { valorCentavos } = await encerrar(pool, FIN, id)
    assert.equal(valorCentavos, '-4000000', 'o ledger recebe o valor congelado')
  })

  // ── Retenção ──────────────────────────────────────────────────────────────

  test('reter é estado, não exclusão — a reversão fica medida', async () => {
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await reter(pool, CSM, id, 'renegociado com desconto de 10%')

    const [s] = await listarSaidas(pool, LIDER)
    assert.equal(s?.estado, 'retido')
    assert.equal(s?.retidoPor, CSM.email)
    assert.ok(s?.retidoEm)
  })

  test('conta retida entra no bruto e sai no líquido, sem apagar o fato', async () => {
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await reter(pool, CSM, id)
    const julho = await resumoChurn(pool, '2026-07-01')
    assert.equal(julho.contasQueLevantaram, 1, 'ela levantou a mão, e isso é um fato')
    assert.equal(julho.retidasDepois, 1, 'e foi revertida — o líquido é zero')
    assert.equal(julho.retidasNaCompetencia, 1, 'a vitória é contada no mês em que ocorreu')
    assert.equal(julho.mrrRetidoCentavos, '4000000')
  })

  test('saída retida não pode ser encerrada depois', async () => {
    const id = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await reter(pool, CSM, id)
    await assert.rejects(
      () => encerrar(pool, FIN, id),
      (e: Error) => {
        assert.match(e.message, /revertida/)
        return true
      },
    )
  })

  // ── O ledger ──────────────────────────────────────────────────────────────

  test('encerrar grava o evento no ledger, na competência do EFEITO', async () => {
    await ateEncerrar()
    const { rows } = await pool.query<{ competencia: string; valor: string; tipo: string }>(
      `SELECT to_char(competencia,'YYYY-MM') competencia, valor_centavos::text valor, tipo
         FROM fact.mrr_event`,
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.competencia, '2026-11', 'não a competência da levantada')
    assert.equal(rows[0]?.valor, '-4000000', 'churn entra negativo')
    assert.equal(rows[0]?.tipo, 'churn_pedido')
  })

  test('encerrar duas vezes não lança duas baixas de receita', async () => {
    // Dois cliques no botão de aprovar não podem virar dois eventos: o ledger é
    // append-only e a correção sairia como ajuste manual três meses depois.
    const id = await ateEncerrar()
    await assert.rejects(() => encerrar(pool, FIN, id), TransicaoInvalidaError)
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) n FROM fact.mrr_event')
    assert.equal(rows[0]?.n, '1')
  })

  test('saída da Alloyal por inadimplência entra como churn_inadimplencia', async () => {
    const id = await anunciar(pool, LIDER, { accountId: acme, origem: 'alloyal', motivo: 'pdd' })
    await confirmarAviso(pool, LIDER, id, 0)
    await confirmarUltimaCobranca(pool, FIN, id, '2026-08')
    await encerrar(pool, FIN, id)
    const { rows } = await pool.query<{ tipo: string }>('SELECT tipo FROM fact.mrr_event')
    assert.equal(rows[0]?.tipo, 'churn_inadimplencia')
  })

  // ── Recusas de entrada ────────────────────────────────────────────────────

  test('levantada de mão sem data é recusada', async () => {
    // É a data do churn de contas: sem ela, o mês da perda é um palpite.
    await assert.rejects(
      () => anunciar(pool, CSM, { accountId: acme, origem: 'cliente' }),
      TransicaoInvalidaError,
    )
  })

  test('duas saídas abertas para a mesma conta são recusadas', async () => {
    // A segunda duplicaria o MRR comprometido, e o número que o board olha
    // apareceria dobrado.
    await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    await assert.rejects(
      () =>
        anunciar(pool, CSM, {
          accountId: acme,
          origem: 'cliente',
          dataLevantada: '2026-07-20',
        }),
      (e: Error) => {
        assert.match(e.message, /já existe uma saída em andamento/)
        return true
      },
    )
  })

  test('depois de encerrada, uma saída nova pode ser aberta', async () => {
    // Cliente que volta e sai de novo é um caso real, e o bloqueio é só sobre
    // saídas ABERTAS.
    await ateEncerrar()
    const outra = await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2027-01-10',
    })
    assert.ok(outra)
  })

  test('conta sem contrato vigente não tem o que congelar', async () => {
    await pool.query(`UPDATE core.contract SET status_vigencia = 'encerrado'`)
    await assert.rejects(
      () =>
        anunciar(pool, CSM, {
          accountId: acme,
          origem: 'cliente',
          dataLevantada: '2026-07-15',
        }),
      (e: Error) => {
        assert.match(e.message, /sem contrato vigente/)
        return true
      },
    )
  })

  // ── Recorte ───────────────────────────────────────────────────────────────

  test('o CSM vê as saídas da própria carteira', async () => {
    await anunciar(pool, CSM, {
      accountId: acme,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
    })
    const outro = quem('bruno@alloyal.com.br', 'ops-csm')
    assert.equal((await listarSaidas(pool, CSM)).length, 1)
    assert.equal((await listarSaidas(pool, outro)).length, 0)
    assert.equal((await listarSaidas(pool, LIDER)).length, 1)
  })
})

test('a taxonomia de motivos é fechada e tem rótulo legível', () => {
  // Com campo aberto, "preço", "custo", "caro" e "orçamento" viram quatro
  // motivos distintos, e "por que perdemos clientes" deixa de ter resposta.
  assert.equal(rotuloDoMotivo('baixa_adesao'), 'Baixa adesão')
  assert.equal(rotuloDoMotivo(null), null)
  assert.ok(MOTIVOS_SAIDA.length <= 10, 'taxonomia grande é preenchida no chute')
  assert.ok(MOTIVOS_SAIDA.some((m) => m.valor === 'outro'), 'sem "outro" a categoria errada é escolhida')
  for (const m of MOTIVOS_SAIDA) assert.ok(m.explica.length > 10, `${m.valor} sem explicação`)
})
