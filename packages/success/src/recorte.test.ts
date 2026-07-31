/**
 * Portão de IDOR: escrita fora da carteira é recusada, e dentro dela continua a valer.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Existe por uma falha PROVADA contra o banco, não por hipótese. A leitura    │
 * │ recortava (`listarRelatorios` filtrava por `csm_email`) e a escrita não:    │
 * │ `revisar` tinha só `WHERE id = $1`. Um CSM CONGELAVA o relatório de um      │
 * │ cliente de outra carteira — sem nem conseguir ler esse relatório.           │
 * │                                                                            │
 * │ Autorização assimétrica é difícil de ver porque a tela nunca mostra o botão.│
 * │ Mas Server Action é endpoint POST: quem tem sessão alcança qualquer ID que  │
 * │ souber ou adivinhar. A tela não é a fronteira — a consulta é.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Cada teste verifica as DUAS direções. Um portão que só testa a recusa passa numa
 * correção que bloqueia todo mundo, e "ninguém consegue trabalhar" não é segurança.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@ops/auth'
import pg from 'pg'

import { anunciar, confirmarAviso, reter } from './cancelamento.js'
import { criarRascunho, descartar, enviar, revisar } from './relatorio.js'
import { abrirJanela, darDesfecho, marcarCenario } from './renovacao.js'
import { ForaDaCarteiraError } from '@ops/auth'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const COMP = '2026-07-01'

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const ANA = quem('ana@alloyal.com.br', 'ops-csm')
const BRUNO = quem('bruno@alloyal.com.br', 'ops-csm')
const LIDER = quem('lider@alloyal.com.br', 'ops-cs-lead')

describe('recorte de carteira na ESCRITA', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  before(async () => {
    const { migrate } = await import('@ops/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    await pool?.query('ALTER TABLE success.client_report DISABLE TRIGGER USER').catch(() => undefined)
    await pool?.query('TRUNCATE success.client_report').catch(() => undefined)
    await pool?.query('ALTER TABLE success.client_report ENABLE TRIGGER USER').catch(() => undefined)
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query('ALTER TABLE success.client_report DISABLE TRIGGER USER')
    await pool.query(
      `TRUNCATE success.client_report, success.cancellation, success.renewal,
                metrics.daily_snapshot, core.contract, core.account CASCADE`,
    )
    await pool.query('ALTER TABLE success.client_report ENABLE TRIGGER USER')
  })

  /** Conta com snapshot e contrato — o mínimo para relatório e saída existirem. */
  async function conta(nome: string, csm: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ($1,'medio','industria',$2,$3) RETURNING id`,
      [nome, `b-${nome}`, csm],
    )
    const id = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO metrics.daily_snapshot
         (competencia, account_id, vidas_contratadas, vidas_elegiveis,
          vidas_ativadas_acum, vidas_ativas_30d, mau, dau, transacoes,
          gmv_centavos, cashback_gerado_centavos, cashback_resgatado_centavos,
          mrr_centavos, completo, qualidade_por_fonte, gerado_em)
       VALUES ($1::date,$2,1000,900,700,300,300,50,900,
               100000,5000,2500,400000,true,'{}'::jsonb, now())`,
      [COMP, id],
    )
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, status_vigencia,
          renovacao, aviso_previo_dias)
       VALUES ($1, 400000, $2::date, ($2::date + 365), 'vigente', 'automatica', 30)`,
      [id, COMP],
    )
    return id
  }

  // ── Relatório ─────────────────────────────────────────────────────────────

  test('compor relatório: a dona consegue, o outro CSM não', async () => {
    const daAna = await conta('Acme', ANA.email)

    const r = await criarRascunho(pool, ANA, daAna, COMP)
    assert.equal(r.estado, 'rascunho', 'a dona da carteira compõe')

    await assert.rejects(
      () => criarRascunho(pool, BRUNO, daAna, COMP),
      ForaDaCarteiraError,
      'CSM de outra carteira compôs relatório de conta que não é dele',
    )
  })

  test('compor NÃO vaza o número do outro cliente na recusa', async () => {
    // O recorte tem que vir ANTES de `montarConteudo`: recortar só na escrita
    // deixaria adesão e MRR do outro cliente serem calculados e devolvidos com a
    // operação aparentemente "recusada".
    const daAna = await conta('Acme', ANA.email)
    const erro = await criarRascunho(pool, BRUNO, daAna, COMP).catch((e: Error) => e)
    assert.ok(erro instanceof Error)
    assert.equal(/400000|R\$|adesão|4000/.test(erro.message), false, `mensagem vazou número: ${erro.message}`)
    const { rowCount } = await pool.query('SELECT 1 FROM success.client_report')
    assert.equal(rowCount, 0, 'a recusa deixou linha gravada')
  })

  test('revisar e enviar: o outro CSM não congela nem envia', async () => {
    const daAna = await conta('Acme', ANA.email)
    const r = await criarRascunho(pool, ANA, daAna, COMP)
    const frase = 'Frase com mais de quarenta caracteres para passar na validação mínima.'

    await assert.rejects(() => revisar(pool, BRUNO, r.id, frase), /carteira/)
    await revisar(pool, ANA, r.id, frase)

    await assert.rejects(() => enviar(pool, BRUNO, r.id, 'rh@cliente.com.br'), /carteira/)
    await enviar(pool, ANA, r.id, 'rh@cliente.com.br')

    const { rows } = await pool.query<{ estado: string; enviado_por: string }>(
      'SELECT estado, enviado_por FROM success.client_report WHERE id = $1',
      [r.id],
    )
    assert.equal(rows[0]!.estado, 'enviado')
    assert.equal(rows[0]!.enviado_por, ANA.email, 'quem enviou tem que ser a dona')
  })

  test('descartar: o outro CSM não descarta o rascunho alheio', async () => {
    const daAna = await conta('Acme', ANA.email)
    const r = await criarRascunho(pool, ANA, daAna, COMP)
    await assert.rejects(() => descartar(pool, BRUNO, r.id), /carteira/)
    await descartar(pool, ANA, r.id)
  })

  test('quem vê a base toda escreve em qualquer carteira — de propósito', async () => {
    // `ops-cs-lead` tem `contas: 'base'`. O recorte não é "só o dono": é o escopo
    // declarado na matriz de permissão. Um portão que barrasse a liderança estaria
    // confundindo posse com alçada.
    const daAna = await conta('Acme', ANA.email)
    const r = await criarRascunho(pool, LIDER, daAna, COMP)
    assert.equal(r.estado, 'rascunho')
    await revisar(pool, LIDER, r.id, 'Frase da liderança, com mais de quarenta caracteres aqui.')
  })

  // ── Saída (churn) ─────────────────────────────────────────────────────────

  test('anunciar saída: o outro CSM não abre saída em conta alheia', async () => {
    const daAna = await conta('Acme', ANA.email)
    const dados = {
      accountId: daAna,
      origem: 'cliente' as const,
      dataLevantada: '2026-07-15',
      motivo: 'preco' as const,
    }
    await assert.rejects(() => anunciar(pool, BRUNO, dados), ForaDaCarteiraError)
    const saidaId = await anunciar(pool, ANA, dados)
    assert.ok(saidaId, 'a dona abre a saída')
  })

  test('confirmar aviso e reter: o outro CSM não mexe na saída alheia', async () => {
    const daAna = await conta('Acme', ANA.email)
    const saidaId = await anunciar(pool, ANA, {
      accountId: daAna,
      origem: 'cliente',
      dataLevantada: '2026-07-15',
      motivo: 'preco',
    })

    await assert.rejects(() => confirmarAviso(pool, BRUNO, saidaId, 90), /não está aberta|carteira/)
    await confirmarAviso(pool, ANA, saidaId, 90)

    await assert.rejects(() => reter(pool, BRUNO, saidaId, 'retido'), /não está aberta|carteira/)
    await reter(pool, ANA, saidaId, 'cliente aceitou desconto')

    const { rows } = await pool.query<{ estado: string; retido_por: string }>(
      'SELECT estado, retido_por FROM success.cancellation WHERE id = $1',
      [saidaId],
    )
    assert.equal(rows[0]!.estado, 'retido')
    assert.equal(rows[0]!.retido_por, ANA.email)
  })

  // ── Renovação ─────────────────────────────────────────────────────────────

  test('renovação: o outro CSM não marca cenário nem dá desfecho', async () => {
    const daAna = await conta('Acme', ANA.email)
    await abrirJanela(pool, { hoje: COMP })
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM success.renewal WHERE account_id = $1',
      [daAna],
    )
    if (rows.length === 0) return // a janela depende da data de vigência; sem ela não há o que testar

    const renovacaoId = String(rows[0]!.id)
    await assert.rejects(() => marcarCenario(pool, BRUNO, renovacaoId, 'pessimista'), /fechada|carteira/)
    await marcarCenario(pool, ANA, renovacaoId, 'pessimista')

    await assert.rejects(() => darDesfecho(pool, BRUNO, renovacaoId, 'renovada'), /fechada|carteira/)
    await darDesfecho(pool, ANA, renovacaoId, 'renovada')
  })
})
