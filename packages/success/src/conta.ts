import type { Identidade } from '@pulse/auth'
import type pg from 'pg'

/**
 * O Cliente 360: tudo que sustenta a pergunta "por que esta conta está na minha
 * fila, e o que eu digo para o cliente".
 *
 * Doc 01, 11.2. O cabeçalho carrega quatro números fixos — adesão, cobertura,
 * faixa de atraso e dias sem contato — porque são os quatro que aparecem em
 * praticamente toda conversa de CS, e tê-los sempre no mesmo lugar é o que
 * substitui a planilha que o CSM monta antes da reunião.
 *
 * Os drivers vêm com o valor E o peso efetivo. Score sem explicação é proibido
 * (doc 00, D7): o CSM precisa poder dizer ao cliente qual número puxou a faixa
 * para baixo, e um número entre 0 e 100 sozinho não permite isso.
 */

export class ContaNaoVisivelError extends Error {
  constructor() {
    super('conta fora do escopo desta pessoa')
    this.name = 'ContaNaoVisivelError'
  }
}

export interface DriverDaConta {
  driver: string
  valor: number | null
  pesoEfetivo: number
  fonteStatus: string
}

export interface Conta360 {
  id: string
  razaoSocial: string
  porte: string | null
  setor: string | null
  csmEmail: string | null

  /** Contrato vigente. `null` quando a conta não tem contrato ativo. */
  mrrCentavos: string | null
  inicio: string | null
  vigenciaFim: string | null
  diasParaVigenciaFim: number | null
  avisoPrevioDias: number | null
  renovacao: string | null

  competencia: string | null
  geradoEm: string | null
  /** Falso quando o snapshot saiu com fonte faltando — o número é parcial. */
  completo: boolean
  qualidadePorFonte: Record<string, unknown>

  /** Os quatro números do cabeçalho. */
  adesao30d: number | null
  coberturaCadastral: number | null
  diasAtrasoMax: number | null
  diasDesdeUltimoContato: number | null

  vidasContratadas: number | null
  vidasElegiveis: number | null
  vidasAtivas30d: number | null
  valorAbertoCentavos: string | null
  gmvCentavos: string | null

  faixaFinal: string | null
  faixaPorRegra: string | null
  scoreComposto: number | null
  scoreCalibrado: boolean
  scoreParcial: boolean
  overrideAtivo: boolean
  overrideMotivo: string | null
  drivers: DriverDaConta[]

  severidadeChurnSilencioso: string | null
  faixaEngajamento: string | null
  diasNaFaixa: number | null

  itensAbertos: Array<{
    id: string
    gatilho: string
    familia: string
    prioridade: string
    motivo: string
    prazo: string
    estado: string
    donoEmail: string
  }>
}

/**
 * Carrega a conta, respeitando o escopo de quem pede.
 *
 * O recorte é aplicado na CONSULTA, não depois: filtrar em memória significa
 * que a conta foi lida do banco antes de a permissão ser checada, e basta um
 * `console.log` de depuração para ela vazar num log.
 */
export async function carregarConta(
  db: pg.Pool,
  id: Identidade,
  accountId: string,
): Promise<Conta360> {
  if (id.permissoes.contas === 'nenhum') throw new ContaNaoVisivelError()
  const daBase = id.permissoes.contas === 'base'

  const { rows } = await db.query<Record<string, unknown>>(
    `WITH ultima AS (
       SELECT max(competencia) c FROM metrics.daily_snapshot WHERE account_id = $1
     )
     SELECT a.id, a.razao_social, a.porte, a.setor, a.csm_email,
            ct.mrr_centavos::text          AS mrr_centavos,
            to_char(ct.inicio,'YYYY-MM-DD')       AS inicio,
            to_char(ct.vigencia_fim,'YYYY-MM-DD') AS vigencia_fim,
            (ct.vigencia_fim - current_date)      AS dias_para_vigencia_fim,
            ct.aviso_previo_dias, ct.renovacao,
            to_char(s.competencia,'YYYY-MM-DD')   AS competencia,
            s.gerado_em, s.completo, s.qualidade_por_fonte,
            s.vidas_contratadas, s.vidas_elegiveis, s.vidas_ativas_30d,
            s.dias_atraso_max, s.dias_desde_ultimo_contato,
            s.valor_aberto_centavos::text AS valor_aberto_centavos,
            s.gmv_centavos::text          AS gmv_centavos,
            sg.faixa_final, sg.faixa_por_regra, sg.score_composto,
            sg.score_calibrado, sg.parcial AS score_parcial,
            sg.override_ativo, sg.override_motivo,
            cf.severidade, cf.faixa_engajamento, cf.dias_na_faixa
       FROM core.account a
       LEFT JOIN LATERAL (
         SELECT * FROM core.contract
          WHERE account_id = a.id AND status_vigencia = 'vigente'
          ORDER BY inicio DESC LIMIT 1
       ) ct ON true
       LEFT JOIN metrics.daily_snapshot s
              ON s.account_id = a.id AND s.competencia = (SELECT c FROM ultima)
       LEFT JOIN metrics.signal sg
              ON sg.account_id = a.id AND sg.competencia = (SELECT c FROM ultima)
       LEFT JOIN metrics.silent_churn_flag cf
              ON cf.account_id = a.id AND cf.competencia = (SELECT c FROM ultima)
      WHERE a.id = $1
        AND ($2::boolean OR a.csm_email = $3)`,
    [accountId, daBase, id.email],
  )

  const r = rows[0]
  if (!r) throw new ContaNaoVisivelError()

  const [{ rows: drivers }, { rows: itens }] = await Promise.all([
    db.query<DriverDaConta>(
      `SELECT driver, valor, peso_efetivo::float8 AS "pesoEfetivo",
              fonte_status AS "fonteStatus"
         FROM metrics.signal_driver
        WHERE account_id = $1 AND competencia = $2::date
        ORDER BY peso_efetivo DESC, driver`,
      [accountId, r['competencia']],
    ),
    db.query(
      `SELECT id, gatilho, familia, prioridade, motivo,
              to_char(prazo,'YYYY-MM-DD') AS prazo, estado,
              dono_email AS "donoEmail"
         FROM success.work_item
        WHERE account_id = $1 AND estado IN ('aberto','backlog')
          -- Item em sombra não aparece nem aqui: o CSM veria o mesmo item que a
          -- fila esconde dele, e o modo sombra deixaria de existir na prática.
          AND NOT modo_sombra
        ORDER BY CASE prioridade WHEN 'critica' THEN 1 WHEN 'alta' THEN 2
                                 WHEN 'media' THEN 3 ELSE 4 END, prazo`,
      [accountId],
    ),
  ])

  const num = (k: string): number | null => (r[k] === null || r[k] === undefined ? null : Number(r[k]))
  const txt = (k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]))

  const elegiveis = num('vidas_elegiveis')
  const contratadas = num('vidas_contratadas')
  const ativas = num('vidas_ativas_30d')

  return {
    id: String(r['id']),
    razaoSocial: String(r['razao_social']),
    porte: txt('porte'),
    setor: txt('setor'),
    csmEmail: txt('csm_email'),
    mrrCentavos: txt('mrr_centavos'),
    inicio: txt('inicio'),
    vigenciaFim: txt('vigencia_fim'),
    diasParaVigenciaFim: num('dias_para_vigencia_fim'),
    avisoPrevioDias: num('aviso_previo_dias'),
    renovacao: txt('renovacao'),
    competencia: txt('competencia'),
    geradoEm: r['gerado_em'] ? new Date(r['gerado_em'] as string).toISOString() : null,
    completo: r['completo'] === true,
    qualidadePorFonte: (r['qualidade_por_fonte'] as Record<string, unknown>) ?? {},
    // Derivados aqui e não no SQL para que a fórmula fique num lugar só, junto
    // do dicionário de métricas que a tela usa para explicar o número.
    adesao30d: elegiveis && elegiveis > 0 && ativas !== null ? ativas / elegiveis : null,
    coberturaCadastral:
      contratadas && contratadas > 0 && elegiveis !== null ? elegiveis / contratadas : null,
    diasAtrasoMax: num('dias_atraso_max'),
    diasDesdeUltimoContato: num('dias_desde_ultimo_contato'),
    vidasContratadas: contratadas,
    vidasElegiveis: elegiveis,
    vidasAtivas30d: ativas,
    valorAbertoCentavos: txt('valor_aberto_centavos'),
    gmvCentavos: txt('gmv_centavos'),
    faixaFinal: txt('faixa_final'),
    faixaPorRegra: txt('faixa_por_regra'),
    scoreComposto: num('score_composto'),
    scoreCalibrado: r['score_calibrado'] === true,
    scoreParcial: r['score_parcial'] === true,
    overrideAtivo: r['override_ativo'] === true,
    overrideMotivo: txt('override_motivo'),
    drivers,
    severidadeChurnSilencioso: txt('severidade'),
    faixaEngajamento: txt('faixa_engajamento'),
    diasNaFaixa: num('dias_na_faixa'),
    itensAbertos: itens as Conta360['itensAbertos'],
  }
}
