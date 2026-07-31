/**
 * O Cliente 360.
 *
 * Duas coisas se testam aqui, e são as duas que causam dano: o RECORTE (um CSM
 * abrindo a conta de outra carteira) e a INTEGRIDADE do que a tela mostra —
 * número parcial que aparece igual a número íntegro é como se perde a confiança
 * no produto inteiro, e não se recupera com um aviso depois.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@pulse/auth'
import pg from 'pg'

import { carregarConta, ContaNaoVisivelError } from './conta.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const COMP = '2026-07-30'

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const ANA = quem('ana@alloyal.com.br', 'pulse-csm')
const BRUNO = quem('bruno@alloyal.com.br', 'pulse-csm')
const LIDER = quem('lider@alloyal.com.br', 'pulse-cs-lead')

describe('cliente 360', { skip: !ADMIN }, () => {
  let pool: pg.Pool
  let acme: string

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
      `TRUNCATE success.work_item, metrics.signal_driver, metrics.signal,
                metrics.silent_churn_flag, metrics.daily_snapshot,
                core.contract, core.account CASCADE`,
    )
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ('Acme','medio','industria','b-acme',$1) RETURNING id`,
      [ANA.email],
    )
    acme = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas,
          aviso_previo_dias, status_vigencia)
       VALUES ($1, 2500000, $2::date - 400, $2::date + 60, 1000, 90, 'vigente')`,
      [acme, COMP],
    )
    await pool.query(
      `INSERT INTO metrics.daily_snapshot
         (competencia, account_id, vidas_contratadas, vidas_elegiveis, vidas_ativas_30d,
          transacoes, dias_atraso_max, valor_aberto_centavos, dias_desde_ultimo_contato,
          completo)
       VALUES ($1,$2,1000,800,240,500,44,780000,70,true)`,
      [COMP, acme],
    )
  })

  // ── Recorte ───────────────────────────────────────────────────────────────

  test('o CSM abre a própria conta', async () => {
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.razaoSocial, 'Acme')
  })

  test('o CSM NÃO abre a conta de outra carteira', async () => {
    // A tela da fila já não mostraria o link — mas a URL é adivinhável, e o
    // recorte precisa valer na consulta, não na navegação.
    await assert.rejects(() => carregarConta(pool, BRUNO, acme), ContaNaoVisivelError)
  })

  test('a liderança abre qualquer conta', async () => {
    const c = await carregarConta(pool, LIDER, acme)
    assert.equal(c.razaoSocial, 'Acme')
  })

  test('conta inexistente falha igual a conta invisível', async () => {
    // Distinguir "não existe" de "existe e não é sua" vaza a existência da conta.
    await assert.rejects(
      () => carregarConta(pool, ANA, '00000000-0000-0000-0000-000000000000'),
      ContaNaoVisivelError,
    )
  })

  // ── Os quatro números do cabeçalho ────────────────────────────────────────

  test('os quatro números do cabeçalho saem calculados', async () => {
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.adesao30d, 240 / 800)
    assert.equal(c.coberturaCadastral, 800 / 1000)
    assert.equal(c.diasAtrasoMax, 44)
    assert.equal(c.diasDesdeUltimoContato, 70)
  })

  test('sem vidas elegíveis a adesão é nula, não zero', async () => {
    // Zero significa "ninguém usou"; nulo significa "não dá para saber". Mostrar
    // 0% para uma base que ainda não foi carregada é dizer que o clube fracassou.
    await pool.query(
      'UPDATE metrics.daily_snapshot SET vidas_elegiveis = 0 WHERE account_id = $1',
      [acme],
    )
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.adesao30d, null)
  })

  // ── Integridade do dado ───────────────────────────────────────────────────

  test('snapshot parcial chega marcado como parcial', async () => {
    await pool.query(
      `UPDATE metrics.daily_snapshot
          SET completo = false, qualidade_por_fonte = '{"omie":"ausente"}'::jsonb
        WHERE account_id = $1`,
      [acme],
    )
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.completo, false)
    assert.deepEqual(c.qualidadePorFonte, { omie: 'ausente' })
  })

  test('conta sem snapshot não inventa números', async () => {
    await pool.query('DELETE FROM metrics.daily_snapshot WHERE account_id = $1', [acme])
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.competencia, null)
    assert.equal(c.adesao30d, null)
    assert.equal(c.diasAtrasoMax, null)
    assert.equal(c.razaoSocial, 'Acme', 'o cadastro continua visível')
  })

  // ── Score explicável ──────────────────────────────────────────────────────

  test('o score vem com os drivers que o formaram', async () => {
    // Score sem explicação é proibido (D7): o CSM precisa dizer ao cliente qual
    // número puxou a faixa, e um valor de 0 a 100 sozinho não permite isso.
    await pool.query(
      `INSERT INTO metrics.signal
         (competencia, account_id, score_composto, drivers_usados, parcial,
          faixa_por_regra, faixa_final)
       VALUES ($1,$2,38,4,false,'risco','risco')`,
      [COMP, acme],
    )
    await pool.query(
      `INSERT INTO metrics.signal_driver (competencia, account_id, driver, valor, peso_efetivo, fonte_status)
       VALUES ($1,$2,'S-FIN',20,0.30,'ok'), ($1,$2,'S-ENG',55,0.25,'ok')`,
      [COMP, acme],
    )
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.scoreComposto, 38)
    assert.equal(c.faixaFinal, 'risco')
    assert.equal(c.drivers.length, 2)
    assert.equal(c.drivers[0]?.driver, 'S-FIN', 'o de maior peso vem primeiro')
    assert.equal(c.drivers[0]?.pesoEfetivo, 0.3)
  })

  test('sem sinal calculado, a conta abre sem faixa em vez de falhar', async () => {
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.faixaFinal, null)
    assert.deepEqual(c.drivers, [])
  })

  // ── Itens de trabalho ─────────────────────────────────────────────────────

  test('os itens abertos da conta aparecem, em ordem de prioridade', async () => {
    for (const [fam, pri] of [
      ['adesao', 'media'],
      ['financeiro', 'critica'],
    ] as const) {
      await pool.query(
        `INSERT INTO success.work_item
           (account_id, gatilho, familia, prioridade, motivo, dono_email, prazo,
            modo_sombra, competencia)
         VALUES ($1,'G-01',$2,$3,'motivo com 40 dias',$4,$5::date + 3,false,$5)`,
        [acme, fam, pri, ANA.email, COMP],
      )
    }
    const c = await carregarConta(pool, ANA, acme)
    assert.deepEqual(
      c.itensAbertos.map((i) => i.prioridade),
      ['critica', 'media'],
    )
  })

  test('item em modo sombra não aparece na conta', async () => {
    // Se aparecesse aqui, o CSM veria o item que a fila esconde dele — e o modo
    // sombra deixaria de existir na prática.
    await pool.query(
      `INSERT INTO success.work_item
         (account_id, gatilho, familia, prioridade, motivo, dono_email, prazo,
          modo_sombra, competencia)
       VALUES ($1,'G-07','churn_silencioso','alta','motivo com 40 dias',$2,$3::date + 3,true,$3)`,
      [acme, ANA.email, COMP],
    )
    const c = await carregarConta(pool, ANA, acme)
    assert.deepEqual(c.itensAbertos, [])
  })

  // ── Contrato ──────────────────────────────────────────────────────────────

  test('a vigência traz os dias que faltam e o aviso prévio', async () => {
    // Sem o aviso prévio ao lado do vencimento, "faltam 60 dias" parece folga
    // quando na verdade o prazo para o cliente avisar já passou.
    const c = await carregarConta(pool, ANA, acme)
    assert.equal(c.avisoPrevioDias, 90)
    assert.ok(c.diasParaVigenciaFim !== null && c.diasParaVigenciaFim <= 60)
    assert.equal(c.mrrCentavos, '2500000')
  })
})
