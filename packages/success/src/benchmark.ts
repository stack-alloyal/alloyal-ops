import { numeroConfigurado } from '@pulse/auth'
import type pg from 'pg'

/**
 * O benchmark por porte e setor — o dado que SAI da empresa.
 *
 * É o único agregado do produto que um cliente vê contendo informação derivada de
 * outros clientes. Por isso o k-anonimato não é conformidade: é a diferença entre
 * "empresas do seu porte ficam em 34%" e "a Construtora Vega, sua concorrente
 * direta, está em 34%".
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Duas condições, e as DUAS têm que valer:                                  │
 * │                                                                           │
 * │   ≥ 5 EMPRESAS  — com 4, um cliente que conhece o mercado deduz quem são; │
 * │                   com 2, a mediana É o número do concorrente.             │
 * │   ≥ 50 PESSOAS  — cinco empresas de 6 vidas cada dão um "benchmark" que   │
 * │                   descreve 30 pessoas, e ninguém deveria decidir com ele. │
 * │                                                                           │
 * │ O banco impõe as duas (`benchmark_k_anonimato`). Este módulo as aplica     │
 * │ antes de gravar, para que a recusa seja uma linha SUPRIMIDA e explicada, e │
 * │ não uma violação de CHECK no meio de um ciclo noturno.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Recorte pequeno não some: ele é gravado com `suprimido = true` e sem valor. A
 * ausência da linha faria a tela do cliente dizer "sem dados", e ele concluiria
 * que a Alloyal não sabe — em vez de entender que o grupo é pequeno demais para
 * comparação, que é a verdade.
 */

/** Mínimo de empresas distintas no recorte. */
export const MINIMO_EMPRESAS = 5

/** Mínimo de pessoas somadas no recorte. */
export const MINIMO_PESSOAS = 50

export interface RecorteBenchmark {
  competencia: string
  porte: string
  setor: string
  metrica: string
  p25: number | null
  p50: number | null
  p75: number | null
  nEmpresas: number
  nPessoas: number
  suprimido: boolean
  /** Por que foi suprimido, para a tela poder explicar em vez de só omitir. */
  motivoSupressao: string | null
}

/**
 * A decisão de supressão, isolada e pura.
 *
 * Separada da consulta de propósito: é a regra que, se errar, expõe dado de
 * cliente a cliente, e uma regra assim tem que ser legível e testável sem banco.
 */
export function decidirSupressao(
  nEmpresas: number,
  nPessoas: number,
  /**
   * Os mínimos EFETIVOS, de `ops.configuracao` — `relatorio.k_minimo_empresas` e
   * `relatorio.k_minimo_pessoas`.
   *
   * `Math.max` com a constante do código não é redundância: a tela recusa valor
   * abaixo do piso e `numeroConfigurado` ignora quem tentar por SQL direto, mas este
   * é o único agregado que SAI da empresa contendo dado derivado de outros clientes.
   * Uma terceira barreira aqui custa uma linha, e o custo do furo é publicar o número
   * de um concorrente no relatório de outro cliente.
   */
  minimos: { empresas: number; pessoas: number } = {
    empresas: MINIMO_EMPRESAS,
    pessoas: MINIMO_PESSOAS,
  },
): { suprimido: boolean; motivo: string | null } {
  const minEmpresas = Math.max(minimos.empresas, MINIMO_EMPRESAS)
  const minPessoas = Math.max(minimos.pessoas, MINIMO_PESSOAS)
  const faltaEmpresa = nEmpresas < minEmpresas
  const faltaPessoa = nPessoas < minPessoas
  if (!faltaEmpresa && !faltaPessoa) return { suprimido: false, motivo: null }

  // O motivo diz QUAL condição falhou e o número. "Recorte pequeno" sem número
  // não permite a ninguém saber quanto falta para ele deixar de ser pequeno.
  const partes: string[] = []
  if (faltaEmpresa) partes.push(`${nEmpresas} de ${minEmpresas} empresas`)
  if (faltaPessoa) partes.push(`${nPessoas} de ${minPessoas} pessoas`)
  return {
    suprimido: true,
    motivo: `recorte com ${partes.join(' e ')} — abaixo do mínimo para comparação anônima`,
  }
}

/**
 * Calcula os percentis por porte × setor × métrica, aplicando a supressão.
 *
 * As métricas comparáveis são só as que fazem sentido entre empresas: adesão e
 * cobertura. GMV e transações dependem do tamanho da base e comparariam uma
 * empresa de 200 vidas com uma de 5 mil — número tecnicamente correto e
 * inutilizável.
 */
export const METRICAS_COMPARAVEIS = ['adesao_30d', 'cobertura_cadastral'] as const

export async function calcularBenchmark(
  db: pg.Pool,
  competencia: string,
): Promise<{ gravados: number; suprimidos: number; recortes: RecorteBenchmark[] }> {
  // Os mínimos configurados, lidos ANTES da transação: uma leitura só por execução, e
  // o valor não muda no meio de um cálculo que grava recorte por recorte.
  const minimos = {
    empresas: await numeroConfigurado(db, 'relatorio.k_minimo_empresas', {
      padrao: MINIMO_EMPRESAS,
      minimo: MINIMO_EMPRESAS,
      maximo: 50,
      inteiro: true,
    }),
    pessoas: await numeroConfigurado(db, 'relatorio.k_minimo_pessoas', {
      padrao: MINIMO_PESSOAS,
      minimo: MINIMO_PESSOAS,
      maximo: 5000,
      inteiro: true,
    }),
  }
  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')

    const { rows } = await cliente.query<{
      porte: string
      setor: string
      metrica: string
      p25: string | null
      p50: string | null
      p75: string | null
      n_empresas: string
      n_pessoas: string
    }>(
      `WITH base AS (
         SELECT a.porte, a.setor, s.account_id,
                -- Vidas ELEGÍVEIS é o denominador do k-anonimato de pessoas: são as
                -- pessoas que efetivamente podem usar o clube, e é sobre elas que o
                -- número fala.
                s.vidas_elegiveis,
                CASE WHEN s.vidas_elegiveis > 0
                     THEN s.vidas_ativas_30d::numeric / s.vidas_elegiveis END AS adesao_30d,
                CASE WHEN s.vidas_contratadas > 0
                     THEN s.vidas_elegiveis::numeric / s.vidas_contratadas END AS cobertura_cadastral
           FROM metrics.daily_snapshot s
           JOIN core.account a ON a.id = s.account_id
          WHERE s.competencia = $1::date
            AND a.porte IS NOT NULL AND a.setor IS NOT NULL
            -- Snapshot parcial fica fora: um benchmark que mistura conta completa
            -- com conta a que faltou uma fonte compara maçã com meia maçã.
            AND s.completo
       ),
       longa AS (
         SELECT porte, setor, 'adesao_30d' AS metrica, account_id, vidas_elegiveis, adesao_30d AS v
           FROM base WHERE adesao_30d IS NOT NULL
         UNION ALL
         SELECT porte, setor, 'cobertura_cadastral', account_id, vidas_elegiveis, cobertura_cadastral
           FROM base WHERE cobertura_cadastral IS NOT NULL
       )
       SELECT porte, setor, metrica,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY v)::text AS p25,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY v)::text AS p50,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY v)::text AS p75,
              count(DISTINCT account_id)::text AS n_empresas,
              COALESCE(sum(vidas_elegiveis), 0)::text AS n_pessoas
         FROM longa
        GROUP BY porte, setor, metrica
        ORDER BY porte, setor, metrica`,
      [competencia],
    )

    const recortes: RecorteBenchmark[] = rows.map((r) => {
      const nEmpresas = Number(r.n_empresas)
      const nPessoas = Number(r.n_pessoas)
      const { suprimido, motivo } = decidirSupressao(nEmpresas, nPessoas, minimos)
      return {
        competencia,
        porte: r.porte,
        setor: r.setor,
        metrica: r.metrica,
        // Suprimido não carrega valor. Se carregasse, uma consulta distraída leria
        // `p50` ignorando o flag — e o banco também recusa.
        p25: suprimido || r.p25 === null ? null : Number(r.p25),
        p50: suprimido || r.p50 === null ? null : Number(r.p50),
        p75: suprimido || r.p75 === null ? null : Number(r.p75),
        nEmpresas,
        nPessoas,
        suprimido,
        motivoSupressao: motivo,
      }
    })

    await cliente.query('DELETE FROM public_v.benchmark_monthly WHERE competencia = $1::date', [
      competencia,
    ])
    for (const r of recortes) {
      await cliente.query(
        `INSERT INTO public_v.benchmark_monthly
           (competencia, porte, setor, metrica, p25, p50, p75, n_empresas, n_pessoas, suprimido)
         VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          competencia,
          r.porte,
          r.setor,
          r.metrica,
          r.p25,
          r.p50,
          r.p75,
          r.nEmpresas,
          r.nPessoas,
          r.suprimido,
        ],
      )
    }

    await cliente.query('COMMIT')
    return {
      gravados: recortes.filter((r) => !r.suprimido).length,
      suprimidos: recortes.filter((r) => r.suprimido).length,
      recortes,
    }
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }
}

export interface Comparativo {
  metrica: string
  /** O valor do cliente. */
  valor: number | null
  p25: number | null
  p50: number | null
  p75: number | null
  nEmpresas: number
  suprimido: boolean
  motivoSupressao: string | null
  /** Onde o cliente está: abaixo do primeiro quartil, no meio, acima do terceiro. */
  posicao: 'abaixo_p25' | 'entre_p25_p50' | 'entre_p50_p75' | 'acima_p75' | null
}

/**
 * O comparativo de uma conta contra o próprio recorte.
 *
 * Devolve a POSIÇÃO e não uma nota: "acima da mediana de empresas do seu porte" é
 * uma frase que um gestor usa numa reunião interna; "nota 7,4" é um número que ele
 * não sabe defender.
 */
export async function comparativoDaConta(
  db: pg.Pool,
  accountId: string,
  competencia: string,
): Promise<Comparativo[]> {
  // Os mesmos mínimos que `calcularBenchmark` usou ao gravar. Ler de novo em vez de
  // confiar no que está gravado é o que garante que o MOTIVO exibido corresponda ao
  // critério em vigor — e não a um critério que mudou depois.
  const minimos = {
    empresas: await numeroConfigurado(db, 'relatorio.k_minimo_empresas', {
      padrao: MINIMO_EMPRESAS,
      minimo: MINIMO_EMPRESAS,
      maximo: 50,
      inteiro: true,
    }),
    pessoas: await numeroConfigurado(db, 'relatorio.k_minimo_pessoas', {
      padrao: MINIMO_PESSOAS,
      minimo: MINIMO_PESSOAS,
      maximo: 5000,
      inteiro: true,
    }),
  }
  const { rows } = await db.query<Record<string, string | null>>(
    `WITH minha AS (
       SELECT a.porte, a.setor,
              CASE WHEN s.vidas_elegiveis > 0
                   THEN s.vidas_ativas_30d::numeric / s.vidas_elegiveis END AS adesao_30d,
              CASE WHEN s.vidas_contratadas > 0
                   THEN s.vidas_elegiveis::numeric / s.vidas_contratadas END AS cobertura_cadastral
         FROM metrics.daily_snapshot s
         JOIN core.account a ON a.id = s.account_id
        WHERE s.account_id = $1 AND s.competencia = $2::date
     )
     SELECT b.metrica, b.p25::text, b.p50::text, b.p75::text,
            b.n_empresas::text, b.n_pessoas::text, b.suprimido::text,
            (CASE b.metrica WHEN 'adesao_30d' THEN m.adesao_30d
                            ELSE m.cobertura_cadastral END)::text AS valor
       FROM minha m
       JOIN public_v.benchmark_monthly b
         ON b.porte = m.porte AND b.setor = m.setor AND b.competencia = $2::date
      ORDER BY b.metrica`,
    [accountId, competencia],
  )

  return rows.map((r) => {
    const suprimido = r['suprimido'] === 'true'
    const valor = r['valor'] === null ? null : Number(r['valor'])
    const p25 = suprimido || r['p25'] === null ? null : Number(r['p25'])
    const p50 = suprimido || r['p50'] === null ? null : Number(r['p50'])
    const p75 = suprimido || r['p75'] === null ? null : Number(r['p75'])
    const nEmpresas = Number(r['n_empresas'])
    const nPessoas = Number(r['n_pessoas'])

    let posicao: Comparativo['posicao'] = null
    if (valor !== null && p25 !== null && p50 !== null && p75 !== null) {
      posicao =
        valor < p25 ? 'abaixo_p25' : valor < p50 ? 'entre_p25_p50' : valor < p75 ? 'entre_p50_p75' : 'acima_p75'
    }

    return {
      metrica: String(r['metrica']),
      valor,
      p25,
      p50,
      p75,
      nEmpresas,
      suprimido,
      // Recalculado das DUAS contagens, não de uma. Passar zero para pessoas faria
      // o motivo dizer "0 de 50 pessoas" mesmo quando a supressão foi só por
      // número de empresas — uma explicação errada é pior que nenhuma, porque
      // manda quem lê tentar resolver o problema que não existe.
      motivoSupressao: suprimido ? decidirSupressao(nEmpresas, nPessoas, minimos).motivo : null,
      posicao,
    }
  })
}
