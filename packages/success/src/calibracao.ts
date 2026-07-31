import { numeroConfigurado } from '@ops/auth'
import { GATILHOS } from '@ops/metrics'
import type pg from 'pg'

/**
 * A calibração de um gatilho: o que a liderança precisa saber para promovê-lo.
 *
 * O modo sombra dura 14 dias e termina numa decisão. Sem esta medição a decisão
 * é uma impressão — e a impressão de quem não abriu os itens. Duas evidências
 * bastam para decidir, e são as duas que estão aqui:
 *
 *   VOLUME — quantos itens por 100 contas por mês, contra a estimativa que o
 *   PRD escreveu antes de existir código. Um gatilho três vezes acima não está
 *   achando três vezes mais problema: está com o limiar errado.
 *
 *   FALSO POSITIVO — a fração dos itens fechados que o time marcou como erro do
 *   gatilho. É o único sinal que separa "a fila está cheia porque a base está
 *   mal" de "a fila está cheia porque o gatilho está mal". Acima de 20% o doc 01
 *   manda recalibrar antes de promover.
 */

export interface Calibracao {
  gatilho: string
  familia: string
  proposito: string
  promovido: boolean
  /**
   * O que falta para o gatilho ser avaliado, ou `null` se nada falta.
   *
   * Distingue "a base está boa e ele não teve o que pegar" de "ele nunca rodou
   * porque o dado não chega" — são conversas diferentes, e a segunda é um
   * pipeline faltando escondido atrás de uma base aparentemente saudável.
   */
  fonteAusente: string | null
  itens: number
  /** Itens por 100 contas por mês — a unidade em que o PRD estimou. */
  porCemContas: number | null
  estimado: readonly [number, number] | null
  veredito: 'sem_dados' | 'ok' | 'acima' | 'abaixo' | 'sem_estimativa'
  fechados: number
  falsosPositivos: number
  /** `null` até haver fechamento suficiente para a fração significar algo. */
  taxaFalsoPositivo: number | null
  diasEmSombra: number | null
}

/** Doc 01, tabela de riscos: acima disso, recalibrar antes de promover. */
export const TETO_FALSO_POSITIVO = 0.2

/** Faixas de `qualidade.teto_falso_positivo` e `fila.dias_de_sombra`. */
const FAIXA_FALSO_POSITIVO = { padrao: TETO_FALSO_POSITIVO, minimo: 0.05, maximo: 0.6 }
const FAIXA_SOMBRA = { padrao: 14, minimo: 7, maximo: 90, inteiro: true }

/**
 * Os dois ajustes da calibração, lidos juntos.
 *
 * `qualidade.teto_falso_positivo` decide quando a tela recomenda despromover um
 * gatilho; `fila.dias_de_sombra` decide quando ele já rodou tempo suficiente para a
 * recomendação valer. Ler os dois separados abriria janela para a tela recomendar
 * com base num período que ela mesma considera curto.
 */
export async function ajustesDaCalibracao(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
}): Promise<{ tetoFalsoPositivo: number; diasDeSombra: number }> {
  return {
    tetoFalsoPositivo: await numeroConfigurado(db, 'qualidade.teto_falso_positivo', FAIXA_FALSO_POSITIVO),
    diasDeSombra: await numeroConfigurado(db, 'fila.dias_de_sombra', FAIXA_SOMBRA),
  }
}

/**
 * Abaixo de 10 fechamentos, a fração de falso positivo é ruído.
 *
 * Com 3 itens fechados, um falso positivo vira "33%" e reprova um gatilho bom.
 * Mostrar `null` e dizer "poucos fechamentos" é mais honesto que mostrar um
 * número que ninguém deveria usar para decidir.
 */
export const MINIMO_PARA_TAXA = 10

interface Bruto {
  gatilho: string
  itens: string
  fechados: string
  falsos: string
  dias_em_sombra: number | null
}

export async function calibracao(
  db: pg.Pool,
  opts: { janelaDias?: number } = {},
): Promise<{ contas: number; janelaDias: number; linhas: Calibracao[] }> {
  const janela = opts.janelaDias ?? 30

  const [{ rows: agg }, { rows: base }, { rows: flags }] = await Promise.all([
    db.query<Bruto>(
      `SELECT w.gatilho,
              count(*)                                            AS itens,
              count(*) FILTER (WHERE w.estado = 'fechado')        AS fechados,
              count(*) FILTER (WHERE w.desfecho = 'falso_positivo') AS falsos,
              -- Há quantos dias este gatilho está produzindo em sombra. É o
              -- relógio dos 14 dias, e ele é do gatilho, não do calendário.
              max(CASE WHEN w.modo_sombra
                       THEN (current_date - w.criado_em::date) END) AS dias_em_sombra
         FROM success.work_item w
        WHERE w.criado_em >= now() - make_interval(days => $1)
        GROUP BY w.gatilho`,
      [janela],
    ),
    db.query<{ n: string }>('SELECT count(*) n FROM core.account'),
    db.query<{ chave: string }>(
      `SELECT chave FROM ops.feature_flag WHERE chave LIKE 'gatilho:%' AND habilitado`,
    ),
  ])

  const contas = Number(base[0]?.n ?? 0)
  const promovidos = new Set(flags.map((f) => f.chave.slice('gatilho:'.length)))
  const porId = new Map(agg.map((a) => [a.gatilho, a]))

  const linhas = GATILHOS.map((g): Calibracao => {
    const a = porId.get(g.id)
    const itens = Number(a?.itens ?? 0)
    const fechados = Number(a?.fechados ?? 0)
    const falsos = Number(a?.falsos ?? 0)

    // Normaliza para itens/100 contas/mês, que é como o PRD estimou. Sem
    // normalizar, o número muda quando a base cresce e a comparação some.
    const porCem =
      contas > 0 ? Number(((itens / contas) * 100 * (30 / janela)).toFixed(1)) : null

    let veredito: Calibracao['veredito'] = 'sem_estimativa'
    if (!g.volumeEstimado) veredito = 'sem_estimativa'
    else if (porCem === null || itens === 0) veredito = 'sem_dados'
    else if (porCem > g.volumeEstimado[1]) veredito = 'acima'
    else if (porCem < g.volumeEstimado[0]) veredito = 'abaixo'
    else veredito = 'ok'

    return {
      gatilho: g.id,
      familia: g.familia,
      proposito: g.proposito,
      promovido: promovidos.has(g.id),
      fonteAusente: g.fonteAusente,
      itens,
      porCemContas: porCem,
      estimado: g.volumeEstimado,
      veredito,
      fechados,
      falsosPositivos: falsos,
      taxaFalsoPositivo:
        fechados >= MINIMO_PARA_TAXA ? Number((falsos / fechados).toFixed(2)) : null,
      diasEmSombra: a?.dias_em_sombra ?? null,
    }
  })

  return { contas, janelaDias: janela, linhas }
}

/**
 * O gatilho está pronto para sair da sombra?
 *
 * Deliberadamente conservador: na dúvida, não promove. O custo de segurar um
 * gatilho bom por mais duas semanas é duas semanas; o custo de promover um
 * gatilho ruidoso é o time parar de confiar na fila — e disso não se volta com
 * um ajuste de limiar.
 */
export function prontoParaPromover(
  c: Calibracao,
  /**
   * Os ajustes em vigor. Parâmetro com padrão, e não leitura de banco aqui: esta
   * função é pura e testada sem banco — é o que permite exercer as sete condições de
   * promoção sem subir Postgres. Quem chama de dentro de uma tela usa
   * `ajustesDaCalibracao` e repassa.
   */
  ajustes: { tetoFalsoPositivo: number; diasDeSombra: number } = {
    tetoFalsoPositivo: TETO_FALSO_POSITIVO,
    diasDeSombra: FAIXA_SOMBRA.padrao,
  },
): {
  pronto: boolean
  porque: string
} {
  if (c.promovido) return { pronto: false, porque: 'já promovido' }
  // A fonte vem antes de tudo: um gatilho sem fonte produz zero itens e o zero
  // parece uma base saudável. Dizer "não produziu nada" seria verdade e mentira
  // ao mesmo tempo — ele nunca chegou a ser avaliado.
  if (c.fonteAusente) return { pronto: false, porque: `sem fonte: ${c.fonteAusente}` }
  if (c.itens === 0) return { pronto: false, porque: 'não produziu nenhum item ainda' }
  if (c.diasEmSombra === null || c.diasEmSombra < ajustes.diasDeSombra) {
    return {
      pronto: false,
      porque: `${c.diasEmSombra ?? 0} de 14 dias em sombra`,
    }
  }
  if (c.veredito === 'acima') {
    return {
      pronto: false,
      porque: `volume ${c.porCemContas}/100 contas contra ${c.estimado?.[0]}–${c.estimado?.[1]} estimados — revisar o limiar antes`,
    }
  }
  if (c.taxaFalsoPositivo !== null && c.taxaFalsoPositivo > ajustes.tetoFalsoPositivo) {
    return {
      pronto: false,
      porque: `${Math.round(c.taxaFalsoPositivo * 100)}% de falso positivo, acima do teto de 20%`,
    }
  }
  if (c.fechados < MINIMO_PARA_TAXA) {
    return {
      pronto: false,
      porque: `só ${c.fechados} item(ns) julgado(s) — sem base para medir precisão`,
    }
  }
  return { pronto: true, porque: 'volume dentro do estimado e precisão medida' }
}
