/**
 * Consolidação — contra Postgres real e massa sintética.
 *
 * É o primeiro teste do repositório que exercita o caminho inteiro: fatos
 * gerados → consolidação → sinais, churn silencioso e agregados do cliente. O
 * que ele verifica são as decisões de produto, não a mecânica de SQL.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import pg from 'pg'

import { consolidar } from './consolidacao.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const HOJE = new Date('2026-07-30T09:00:00Z')
const COMPETENCIA = '2026-07-30'

describe('consolidação diária', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  before(async () => {
    const { migrate, semear } = await import('@ops/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
    await semear(pool, { contas: 24, dias: 90, hoje: new Date('2026-07-30T00:00:00Z') })
    await consolidar(pool, COMPETENCIA, { agora: HOJE })
  })

  after(async () => {
    await pool?.end()
  })

  test('toda conta com snapshot recebe um sinal', async () => {
    const { rows } = await pool.query<{ contas: string; sinais: string }>(
      `SELECT (SELECT count(*) FROM metrics.daily_snapshot WHERE competencia = $1) contas,
              (SELECT count(*) FROM metrics.signal WHERE competencia = $1) sinais`,
      [COMPETENCIA],
    )
    assert.equal(rows[0]?.sinais, rows[0]?.contas)
    assert.ok(Number(rows[0]?.contas) > 0)
  })

  test('o score composto NÃO é publicado antes de calibrado', async () => {
    // Pesos adivinhados erram a ordenação, o CSM percebe em duas semanas, e
    // desconfiança de número não se desfaz. Até a calibração, o que se mostra é
    // a faixa por regra — verificável na hora.
    const { rows } = await pool.query<{ com_score: string; calibrados: string }>(
      `SELECT count(*) FILTER (WHERE score_composto IS NOT NULL) com_score,
              count(*) FILTER (WHERE score_calibrado) calibrados
         FROM metrics.signal WHERE competencia = $1`,
      [COMPETENCIA],
    )
    assert.equal(Number(rows[0]?.com_score), 0)
    assert.equal(Number(rows[0]?.calibrados), 0)
  })

  test('driver sem fonte sai da conta e o peso é redistribuído', async () => {
    // A conta sem engajamento: o driver não entra como zero — ele desaparece, e
    // os oito que ficaram passam a somar 100.
    const { rows } = await pool.query<{
      account_id: string
      usados: number
      ausentes: string
      soma_peso: string
    }>(
      `SELECT s.account_id, s.drivers_usados AS usados,
              count(*) FILTER (WHERE d.fonte_status = 'ausente') ausentes,
              round(sum(d.peso_efetivo), 0) soma_peso
         FROM metrics.signal s
         JOIN metrics.signal_driver d USING (competencia, account_id)
        WHERE s.competencia = $1
        GROUP BY s.account_id, s.drivers_usados
        ORDER BY ausentes DESC LIMIT 1`,
      [COMPETENCIA],
    )
    const r = rows[0]!
    assert.ok(Number(r.ausentes) > 0, 'a massa precisa ter conta com fonte ausente')
    assert.equal(Number(r.soma_peso), 100, 'os pesos renormalizados têm que somar 100')
    assert.equal(r.usados, 9 - Number(r.ausentes))
  })

  test('driver ausente tem valor nulo, nunca zero', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM metrics.signal_driver
        WHERE competencia = $1 AND fonte_status = 'ausente' AND valor IS NOT NULL`,
      [COMPETENCIA],
    )
    assert.equal(Number(rows[0]?.n), 0)
  })

  test('a faixa segue o pior driver ABSOLUTO, não a média nem o percentil', async () => {
    // O caso que a média esconde: conta ótima em quase tudo e inadimplente.
    // E o caso que o percentil inventa: alguém está sempre no último quartil de
    // intensidade, e isso não faz da conta um problema.
    const { rows } = await pool.query<{ faixa: string; pior: number }>(
      `SELECT s.faixa_por_regra faixa, min(d.valor) pior
         FROM metrics.signal s
         JOIN metrics.signal_driver d USING (competencia, account_id)
        WHERE s.competencia = $1 AND d.valor IS NOT NULL
          AND d.driver <> 'S-USO'
        GROUP BY s.account_id, s.faixa_por_regra`,
      [COMPETENCIA],
    )
    for (const r of rows) {
      const esperada =
        r.pior < 25 ? 'critico' : r.pior < 50 ? 'risco' : r.pior < 70 ? 'atencao' : 'saudavel'
      assert.equal(r.faixa, esperada, `pior driver ${r.pior} deveria dar ${esperada}`)
    }
  })

  test('a qualidade por fonte é registrada e marca a competência', async () => {
    const { rows } = await pool.query<{ completos: string; parciais: string; sem_qualidade: string }>(
      `SELECT count(*) FILTER (WHERE completo) completos,
              count(*) FILTER (WHERE NOT completo) parciais,
              count(*) FILTER (WHERE qualidade_por_fonte = '{}'::jsonb) sem_qualidade
         FROM metrics.daily_snapshot WHERE competencia = $1`,
      [COMPETENCIA],
    )
    assert.equal(Number(rows[0]?.sem_qualidade), 0, 'toda linha precisa carregar o veredito')
    // A massa tem conta sem fonte de engajamento: ela não pode ser completa.
    assert.ok(Number(rows[0]?.parciais) > 0)
    assert.ok(Number(rows[0]?.completos) > 0)
  })

  test('recorte pequeno é suprimido e não carrega valor', async () => {
    const { rows } = await pool.query<{ n: string; com_valor: string; n_base: number }>(
      `SELECT count(*) n, count(*) FILTER (WHERE valor IS NOT NULL) com_valor, max(n_base) n_base
         FROM public_v.metric_daily WHERE competencia = $1 AND suprimido`,
      [COMPETENCIA],
    )
    assert.ok(Number(rows[0]?.n) > 0, 'a massa precisa ter recorte pequeno')
    // Devolver vazio faria o gestor de um cliente pequeno concluir que o clube
    // não funciona; o valor fica nulo e o estado explica a regra.
    assert.equal(Number(rows[0]?.com_valor), 0)
    assert.ok(rows[0]!.n_base < 5)
  })

  test('recorte suficiente é publicado com valor', async () => {
    const { rows } = await pool.query<{ n: string; sem_valor: string }>(
      `SELECT count(*) n, count(*) FILTER (WHERE valor IS NULL) sem_valor
         FROM public_v.metric_daily
        WHERE competencia = $1 AND NOT suprimido AND metrica = 'adesao_30d'`,
      [COMPETENCIA],
    )
    assert.ok(Number(rows[0]?.n) > 0)
    assert.equal(Number(rows[0]?.sem_valor), 0)
  })

  test('churn silencioso classifica pelos dois vetores', async () => {
    const { rows } = await pool.query<{ severidade: string; faixa_atraso: string; n: string }>(
      `SELECT severidade, faixa_atraso, count(*) n
         FROM metrics.silent_churn_flag WHERE competencia = $1
        GROUP BY 1,2 ORDER BY 3 DESC`,
      [COMPETENCIA],
    )
    assert.ok(rows.length > 0, 'a massa precisa produzir churn silencioso')
    // Acima de 90 dias é PDD qualquer que seja o engajamento.
    for (const r of rows) {
      if (r.faixa_atraso === 'acima_90') assert.equal(r.severidade, 'pdd')
    }
  })

  test('paga em dia e parou de usar aparece como risco', async () => {
    // A célula que a matriz existe para pegar: sem os dois vetores, este cliente
    // é invisível até a renovação.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM metrics.silent_churn_flag
        WHERE competencia = $1 AND faixa_atraso = 'adimplente'
          AND faixa_engajamento IN ('baixo','nulo')`,
      [COMPETENCIA],
    )
    assert.ok(Number(rows[0]?.n) > 0)
  })

  test('conta que sai do churn silencioso perde a marca', async () => {
    // Reconsolidar tem que refletir o estado atual, não acumular marcas antigas.
    const antes = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM metrics.silent_churn_flag WHERE competencia = $1`,
      [COMPETENCIA],
    )
    await pool.query(
      `UPDATE metrics.daily_snapshot
          SET dias_atraso_max = 0, vidas_ativas_30d = vidas_elegiveis
        WHERE competencia = $1`,
      [COMPETENCIA],
    )
    await consolidar(pool, COMPETENCIA, { agora: HOJE })
    const depois = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM metrics.silent_churn_flag WHERE competencia = $1`,
      [COMPETENCIA],
    )
    assert.ok(Number(depois.rows[0]?.n) < Number(antes.rows[0]?.n))
  })

  test('reconsolidar é idempotente', async () => {
    const contar = async () => {
      const { rows } = await pool.query<{ s: string; d: string; p: string }>(
        `SELECT (SELECT count(*) FROM metrics.signal WHERE competencia = $1) s,
                (SELECT count(*) FROM metrics.signal_driver WHERE competencia = $1) d,
                (SELECT count(*) FROM public_v.metric_daily WHERE competencia = $1) p`,
        [COMPETENCIA],
      )
      return rows[0]
    }
    const a = await contar()
    await consolidar(pool, COMPETENCIA, { agora: HOJE })
    assert.deepEqual(await contar(), a)
  })

  test('o piso é uma fração da mediana, não a mediana', async () => {
    // Usar a mediana como piso deixa metade da base abaixo dele por definição,
    // todo dia, mesmo com a base inteira saudável. O que se quer marcar não é
    // "abaixo da média", é "muito pior que os pares".
    const r = await consolidar(pool, COMPETENCIA, { agora: HOJE })
    for (const [porte, piso] of Object.entries(r.pisosPorPorte)) {
      const { rows } = await pool.query<{ mediana: string }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY s.vidas_ativas_30d::numeric / NULLIF(s.vidas_elegiveis, 0)
                ) mediana
           FROM metrics.daily_snapshot s JOIN core.account a ON a.id = s.account_id
          WHERE s.competencia = $1 AND a.porte = $2 AND s.vidas_elegiveis > 0`,
        [COMPETENCIA, porte],
      )
      const mediana = Number(rows[0]?.mediana ?? 0)
      if (mediana > 0.3) assert.ok(piso < mediana, `${porte}: piso ${piso} não é menor que a mediana`)
    }
  })

  test('a base não fica inteira em situação crítica', async () => {
    // Uma classificação em que quase tudo é crítico não ordena nada — e é o
    // sintoma de um driver relativo decidindo a faixa.
    const { rows } = await pool.query<{ faixa: string; n: string }>(
      `SELECT faixa_por_regra faixa, count(*) n FROM metrics.signal
        WHERE competencia = $1 GROUP BY 1`,
      [COMPETENCIA],
    )
    const total = rows.reduce((a, r) => a + Number(r.n), 0)
    const criticos = Number(rows.find((r) => r.faixa === 'critico')?.n ?? 0)
    assert.ok(criticos / total < 0.6, `${criticos} de ${total} críticos`)
    assert.ok(rows.length >= 3, 'a base precisa se distribuir em mais de duas faixas')
  })

  test('competência sem snapshot não quebra', async () => {
    const r = await consolidar(pool, '2019-01-01', { agora: HOJE })
    assert.equal(r.contas, 0)
    assert.equal(r.sinais, 0)
  })
})
