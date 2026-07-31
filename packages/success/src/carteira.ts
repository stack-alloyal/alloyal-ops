import type { Identidade } from '@ops/auth'
import type pg from 'pg'

/**
 * T3 — A carteira. A tela do "onde eu olho".
 *
 * A fila mostra 12 itens; a carteira tem 30 contas. As 18 que não geraram item hoje
 * não são invisíveis — são o trabalho que ainda não virou urgente, e é olhando para
 * elas que se evita que virem.
 *
 * A ordem é a decisão de produto desta tela. Por faixa de risco só, o CSM começa por
 * uma conta crítica de R$ 800 e deixa uma conta em risco de R$ 40 mil para depois.
 * Por MRR só, ele começa pela maior mesmo quando ela está saudável. A ordem é o
 * PRODUTO dos dois — risco ponderado por receita — que é a única que responde "qual
 * conversa eu tenho hoje".
 */

/** Peso de cada faixa na ordenação. Só a diferença relativa importa. */
export const PESO_FAIXA: Readonly<Record<string, number>> = {
  critico: 8,
  risco: 4,
  atencao: 2,
  saudavel: 1,
}

export interface ContaDaCarteira {
  id: string
  razaoSocial: string
  porte: string | null
  setor: string | null
  csmEmail: string | null
  mrrCentavos: string | null
  faixa: string | null
  scoreComposto: number | null
  scoreParcial: boolean
  /** Os quatro números do cabeçalho do Cliente 360, aqui em coluna. */
  adesao30d: number | null
  coberturaCadastral: number | null
  diasAtrasoMax: number | null
  diasDesdeUltimoContato: number | null
  competencia: string | null
  /** Falso quando o snapshot saiu com fonte faltando. */
  completo: boolean
  itensAbertos: number
  /** Dias até a vigência acabar; negativo se passou. */
  diasParaVigencia: number | null
  /** Cláusulas propostas e não conferidas — dado que ainda não decide. */
  clausulasPropostas: number
  /**
   * Risco × receita. É a ordem da tela, e vem calculado do banco para a
   * paginação futura não precisar carregar tudo em memória para ordenar.
   */
  pesoDeAtencao: number
}

export interface Carteira {
  contas: ContaDaCarteira[]
  /** Verdadeiro quando a pessoa enxerga a base inteira. */
  visaoDaBase: boolean
  /** Contas sem sinal calculado — nem saudáveis nem em risco: sem resposta. */
  semSinal: number
}

/**
 * Carrega a carteira.
 *
 * `semSinal` é contado à parte de propósito. Conta sem sinal calculado não é conta
 * saudável: é conta sobre a qual não se sabe nada, e somá-la ao verde faria a
 * carteira parecer melhor do que é — exatamente a leitura que atrasa a descoberta
 * de um problema.
 */
export async function carregarCarteira(
  db: pg.Pool,
  id: Identidade,
  opts: { faixa?: string; hoje?: string } = {},
): Promise<Carteira> {
  if (id.permissoes.contas === 'nenhum') {
    return { contas: [], visaoDaBase: false, semSinal: 0 }
  }
  const daBase = id.permissoes.contas === 'base'
  const hoje = opts.hoje ?? new Date().toISOString().slice(0, 10)

  const { rows } = await db.query<Record<string, unknown>>(
    `WITH ultima AS (SELECT max(competencia) c FROM metrics.daily_snapshot)
     SELECT a.id, a.razao_social, a.porte, a.setor, a.csm_email,
            ct.mrr_centavos::text                   AS mrr,
            sg.faixa_final, sg.score_composto, sg.parcial AS score_parcial,
            to_char(s.competencia,'YYYY-MM-DD')     AS competencia,
            s.completo,
            s.vidas_elegiveis, s.vidas_ativas_30d, s.vidas_contratadas,
            s.dias_atraso_max, s.dias_desde_ultimo_contato,
            (ct.vigencia_fim - $3::date)            AS dias_vigencia,
            COALESCE(wi.n, 0)                       AS itens,
            COALESCE(cl.n, 0)                       AS propostas
       FROM core.account a
       LEFT JOIN LATERAL (
         SELECT mrr_centavos, vigencia_fim FROM core.contract
          WHERE account_id = a.id AND status_vigencia = 'vigente'
          ORDER BY inicio DESC LIMIT 1
       ) ct ON true
       LEFT JOIN metrics.daily_snapshot s
              ON s.account_id = a.id AND s.competencia = (SELECT c FROM ultima)
       LEFT JOIN metrics.signal sg
              ON sg.account_id = a.id AND sg.competencia = (SELECT c FROM ultima)
       -- Itens VISÍVEIS: o de modo sombra não é trabalho de ninguém, e contá-lo
       -- aqui faria a carteira parecer mais carregada do que está.
       LEFT JOIN LATERAL (
         SELECT count(*)::int n FROM success.work_item
          WHERE account_id = a.id AND estado IN ('aberto','backlog') AND NOT modo_sombra
       ) wi ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int n FROM contracts.clause
          WHERE account_id = a.id AND estado = 'proposta' AND valido_ate IS NULL
       ) cl ON true
      WHERE ($1::boolean OR a.csm_email = $2)
        AND ($4::text IS NULL OR sg.faixa_final = $4)`,
    [daBase, id.email, hoje, opts.faixa ?? null],
  )

  const num = (r: Record<string, unknown>, k: string): number | null =>
    r[k] === null || r[k] === undefined ? null : Number(r[k])

  const contas = rows.map((r): ContaDaCarteira => {
    const elegiveis = num(r, 'vidas_elegiveis')
    const ativas = num(r, 'vidas_ativas_30d')
    const contratadas = num(r, 'vidas_contratadas')
    const faixa = r['faixa_final'] === null ? null : String(r['faixa_final'])
    const mrr = r['mrr'] === null ? null : String(r['mrr'])

    return {
      id: String(r['id']),
      razaoSocial: String(r['razao_social']),
      porte: r['porte'] === null ? null : String(r['porte']),
      setor: r['setor'] === null ? null : String(r['setor']),
      csmEmail: r['csm_email'] === null ? null : String(r['csm_email']),
      mrrCentavos: mrr,
      faixa,
      scoreComposto: num(r, 'score_composto'),
      scoreParcial: r['score_parcial'] === true,
      adesao30d: elegiveis && elegiveis > 0 && ativas !== null ? ativas / elegiveis : null,
      coberturaCadastral:
        contratadas && contratadas > 0 && elegiveis !== null ? elegiveis / contratadas : null,
      diasAtrasoMax: num(r, 'dias_atraso_max'),
      diasDesdeUltimoContato: num(r, 'dias_desde_ultimo_contato'),
      competencia: r['competencia'] === null ? null : String(r['competencia']),
      completo: r['completo'] === true,
      itensAbertos: Number(r['itens'] ?? 0),
      diasParaVigencia: num(r, 'dias_vigencia'),
      clausulasPropostas: Number(r['propostas'] ?? 0),
      // Conta sem faixa recebe peso de `atencao`: ela não é saudável — é
      // desconhecida, e desconhecido não pode afundar na lista.
      pesoDeAtencao: (PESO_FAIXA[faixa ?? 'atencao'] ?? 2) * (mrr === null ? 0 : Number(mrr) / 100),
    }
  })

  contas.sort((a, b) => b.pesoDeAtencao - a.pesoDeAtencao || a.razaoSocial.localeCompare(b.razaoSocial))

  return {
    contas,
    visaoDaBase: daBase,
    semSinal: contas.filter((c) => c.faixa === null).length,
  }
}

export interface ResumoCarteira {
  total: number
  mrrTotalCentavos: string
  porFaixa: Array<{ faixa: string; contas: number; mrrCentavos: string }>
  /** Contas sem nenhum item aberto — o trabalho que ainda não virou urgente. */
  semItem: number
  /** Contas com dado parcial: o número delas não é comparável ao das outras. */
  parciais: number
  comClausulaProposta: number
}

/**
 * O resumo da carteira.
 *
 * `semItem` é o número que a fila não mostra: são as contas que não geraram trabalho
 * hoje. Metade delas está bem; a outra metade é onde o próximo problema nasce, e é a
 * única forma de olhar para ele antes de virar item.
 */
export function resumir(carteira: Carteira): ResumoCarteira {
  const porFaixa = new Map<string, { contas: number; mrr: number }>()
  let mrrTotal = 0

  for (const c of carteira.contas) {
    const mrr = c.mrrCentavos === null ? 0 : Number(c.mrrCentavos)
    mrrTotal += mrr
    const k = c.faixa ?? 'sem_sinal'
    const atual = porFaixa.get(k) ?? { contas: 0, mrr: 0 }
    porFaixa.set(k, { contas: atual.contas + 1, mrr: atual.mrr + mrr })
  }

  const ordem = ['critico', 'risco', 'atencao', 'saudavel', 'sem_sinal']
  return {
    total: carteira.contas.length,
    mrrTotalCentavos: String(mrrTotal),
    porFaixa: [...porFaixa.entries()]
      .sort(([a], [b]) => ordem.indexOf(a) - ordem.indexOf(b))
      .map(([faixa, v]) => ({ faixa, contas: v.contas, mrrCentavos: String(v.mrr) })),
    semItem: carteira.contas.filter((c) => c.itensAbertos === 0).length,
    parciais: carteira.contas.filter((c) => c.competencia !== null && !c.completo).length,
    comClausulaProposta: carteira.contas.filter((c) => c.clausulasPropostas > 0).length,
  }
}
