import { defineMetric } from '../define.js'

/**
 * Métricas de conta: base, adesão, resultado e financeiro.
 *
 * Doc 01, seção 5.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ A palavra "adesão" sem qualificador é PROIBIDA nesta base de código,    │
 * │ em interface, em relatório e em conversa.                               │
 * │                                                                          │
 * │ O PRD v1.0 declarava dois denominadores diferentes ("vidas contratadas"  │
 * │ e "vidas elegíveis"), em fontes diferentes, para a métrica central do    │
 * │ produto. Um cliente com 1.000 contratadas, 700 elegíveis e 300 ativas    │
 * │ tem cobertura de 70% e adesão de 43% — e não tem "adesão de 30%".        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const REPLICA = { ciclo: 'C2', fonte: 'replica' } as const
const REPLICA_TX = { ciclo: 'C1', fonte: 'replica' } as const
const HUBSPOT = { ciclo: 'C4', fonte: 'hubspot' } as const
const OMIE = { ciclo: 'C8', fonte: 'omie' } as const

// ─── Base ────────────────────────────────────────────────────────────────────

export const vidasContratadas = defineMetric({
  id: 'vidas_contratadas',
  nome: 'Vidas contratadas',
  formula: 'vidas_contratadas',
  unidade: 'inteiro',
  granularidade: 'conta_dia',
  fontes: [HUBSPOT],
  dono: 'Data Owner',
  versao: 1,
  explicacao: 'Quantas vidas o cliente contratou, conforme o contrato vigente.',
})

export const vidasElegiveis = defineMetric({
  id: 'vidas_elegiveis',
  nome: 'Vidas elegíveis',
  formula: 'vidas_elegiveis',
  unidade: 'inteiro',
  granularidade: 'conta_dia',
  fontes: [REPLICA],
  dono: 'Data Owner',
  versao: 1,
  explicacao: 'Quantas pessoas o cliente efetivamente cadastrou na base do clube.',
})

/**
 * A métrica que separa "o cliente não usa" de "o cliente não cadastrou".
 *
 * É driver de score desde a F1 e gatilho de fila (G-06) desde a F2, porque é a
 * única alavanca de adesão que depende inteiramente do cliente — e portanto a
 * primeira coisa a cobrar antes de discutir engajamento.
 */
export const coberturaCadastral = defineMetric({
  id: 'cobertura_cadastral',
  nome: 'Cobertura cadastral',
  formula: 'vidas_elegiveis::numeric / NULLIF(vidas_contratadas, 0)',
  unidade: 'percentual',
  granularidade: 'conta_dia',
  fontes: [REPLICA, HUBSPOT],
  dono: 'Data Owner',
  versao: 1,
  explicacao:
    'Quanto do contrato o cliente já ativou administrativamente: vidas cadastradas sobre vidas contratadas. Depende do cliente, não da Alloyal.',
})

// ─── Adesão — as três métricas ───────────────────────────────────────────────

/** Alcance histórico. Cumulativa: nunca cai. Métrica de implantação. */
export const adesaoAtivacao = defineMetric({
  id: 'adesao_ativacao',
  nome: 'Adesão — ativação',
  formula: 'vidas_ativadas_acum::numeric / NULLIF(vidas_elegiveis, 0)',
  unidade: 'percentual',
  granularidade: 'conta_dia',
  fontes: [REPLICA, REPLICA_TX],
  dono: 'DEF-01',
  versao: 1,
  explicacao:
    'Quantas pessoas da base já usaram o clube ao menos uma vez, sobre as vidas cadastradas. Cumulativa: nunca cai. Serve para medir implantação.',
})

/** Saúde corrente. Métrica principal do produto. */
export const adesao30d = defineMetric({
  id: 'adesao_30d',
  nome: 'Adesão 30 dias',
  formula: 'vidas_ativas_30d::numeric / NULLIF(vidas_elegiveis, 0)',
  unidade: 'percentual',
  granularidade: 'conta_dia',
  fontes: [REPLICA, REPLICA_TX],
  dono: 'DEF-01',
  versao: 1,
  explicacao:
    'Quantas pessoas da base usaram o clube nos últimos 30 dias, sobre as vidas cadastradas. É a métrica principal de saúde do cliente.',
})

/**
 * Definição de "uso", versionada.
 *
 * Versão 1 (hoje): transação concluída ∪ resgate de cashback.
 * Versão 2 (quando V-08/V-09 forem respondidas): acrescenta sessão no app.
 *
 * A mudança sobe a versão e a série ganha quebra visível. O passado NÃO é
 * reescrito — doc 00, 6.7.
 */
export const DEFINICAO_USO_VERSAO = 1

// ─── Resultado ───────────────────────────────────────────────────────────────

export const gmv = defineMetric({
  id: 'gmv_centavos',
  nome: 'GMV',
  formula: 'gmv_centavos',
  unidade: 'centavos',
  granularidade: 'conta_mes',
  fontes: [REPLICA_TX],
  dono: 'Data Owner',
  versao: 1,
  explicacao: 'Soma do valor das transações concluídas da base do cliente na competência.',
})

export const ticketMedio = defineMetric({
  id: 'ticket_medio_centavos',
  nome: 'Ticket médio',
  formula: 'gmv_centavos::numeric / NULLIF(transacoes, 0)',
  unidade: 'centavos',
  granularidade: 'conta_mes',
  fontes: [REPLICA_TX],
  dono: 'Data Owner',
  versao: 1,
  explicacao: 'Valor médio por transação da base do cliente.',
})

export const transacoesPorVidaAtiva = defineMetric({
  id: 'transacoes_por_vida_ativa',
  nome: 'Transações por vida ativa',
  formula: 'transacoes::numeric / NULLIF(vidas_ativas_30d, 0)',
  unidade: 'razao',
  granularidade: 'conta_mes',
  fontes: [REPLICA_TX, REPLICA],
  dono: 'Data Owner',
  versao: 1,
  explicacao:
    'Intensidade de uso: quantas vezes, em média, cada pessoa ativa usou o clube. Separa clube com muita gente usando pouco de clube com pouca gente usando muito.',
})

/** O número que o gestor do cliente entende sem explicação. */
export const economiaPorVidaAtiva = defineMetric({
  id: 'economia_por_vida_ativa_centavos',
  nome: 'Economia por vida ativa',
  formula: 'cashback_gerado_centavos::numeric / NULLIF(vidas_ativas_30d, 0)',
  unidade: 'centavos',
  granularidade: 'conta_mes',
  fontes: [REPLICA_TX, REPLICA],
  dono: 'Data Owner',
  versao: 1,
  explicacao:
    'Quanto cada pessoa que usou o clube economizou, em média, na competência. É o número que traduz o benefício para o colaborador.',
})

// ─── Financeiro ──────────────────────────────────────────────────────────────

export const diasAtrasoMax = defineMetric({
  id: 'dias_atraso_max',
  nome: 'Dias de atraso',
  formula: 'dias_atraso_max',
  unidade: 'dias',
  granularidade: 'conta_atual',
  fontes: [OMIE],
  dono: 'Financeiro',
  versao: 1,
  explicacao:
    'Maior atraso entre os títulos em aberto do cliente. Alimenta o driver de maior peso do score e o vetor de inadimplência do churn silencioso.',
  sensivel: true,
})

export const valorEmAberto = defineMetric({
  id: 'valor_aberto_centavos',
  nome: 'Valor em aberto',
  formula: 'valor_aberto_centavos',
  unidade: 'centavos',
  granularidade: 'conta_atual',
  fontes: [OMIE],
  dono: 'Financeiro',
  versao: 1,
  explicacao: 'Soma dos títulos vencidos e não pagos do cliente.',
  sensivel: true,
})

/** Faixas usadas pela matriz de churn silencioso (doc 01, 7.1). */
export const FAIXAS_ATRASO = [
  { id: 'adimplente', ate: 0 },
  { id: '1_30', ate: 30 },
  { id: '31_60', ate: 60 },
  { id: '61_90', ate: 90 },
  { id: 'acima_90', ate: Number.POSITIVE_INFINITY },
] as const

export type FaixaAtraso = (typeof FAIXAS_ATRASO)[number]['id']

export function faixaAtraso(dias: number): FaixaAtraso {
  for (const faixa of FAIXAS_ATRASO) {
    if (dias <= faixa.ate) return faixa.id
  }
  return 'acima_90'
}
