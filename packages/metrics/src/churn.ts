import type { FaixaAtraso } from './catalog/conta.js'

/**
 * Churn silencioso — matriz de severidade.
 *
 * Doc 01, seção 7.
 *
 * Cliente que ainda não cancelou mas já parou de ser cliente. Dois vetores
 * independentes levam ao mesmo destino e se combinam:
 *
 *   • desengajamento  — o clube existe no contrato, não na prática;
 *   • inadimplência   — a decisão de sair já foi tomada, só não foi comunicada.
 */

export type FaixaEngajamento = 'saudavel' | 'em_queda' | 'baixo' | 'nulo'

export type Severidade = 'saudavel' | 'atencao' | 'risco' | 'risco_alto' | 'critico' | 'pdd'

/**
 * A matriz de 4 × 5.
 *
 * Note que 19 das 20 células geram trabalho. É o motivo pelo qual o motor de
 * fila tem teto de carga, deduplicação por família e carência (doc 00, seção 7):
 * sem isso, esta matriz sozinha satura a fila de qualquer CSM.
 */
const MATRIZ: Record<FaixaEngajamento, Record<FaixaAtraso, Severidade>> = {
  saudavel: {
    adimplente: 'saudavel',
    '1_30': 'atencao',
    '31_60': 'risco',
    '61_90': 'risco_alto',
    acima_90: 'pdd',
  },
  em_queda: {
    adimplente: 'atencao',
    '1_30': 'risco',
    '31_60': 'risco_alto',
    '61_90': 'critico',
    acima_90: 'pdd',
  },
  baixo: {
    adimplente: 'risco',
    '1_30': 'risco_alto',
    '31_60': 'critico',
    '61_90': 'critico',
    acima_90: 'pdd',
  },
  nulo: {
    adimplente: 'risco_alto',
    '1_30': 'critico',
    '31_60': 'critico',
    '61_90': 'critico',
    acima_90: 'pdd',
  },
}

export function severidade(
  engajamento: FaixaEngajamento,
  atraso: FaixaAtraso,
): Severidade {
  return MATRIZ[engajamento][atraso]
}

/**
 * Dono do playbook por faixa.
 *
 * O escalonamento troca de dono de propósito: PDD é decisão de crédito e o gate
 * é do Financeiro, nunca do CS (doc 01, 7.3). Deixar o CS aprovando rescisão por
 * inadimplemento é colocar quem tem relacionamento com o cliente para tomar a
 * decisão que o relacionamento impede.
 */
export const DONO_POR_SEVERIDADE: Record<Severidade, string> = {
  saudavel: '—',
  atencao: 'csm',
  risco: 'csm',
  risco_alto: 'csm_com_ciencia_da_lideranca',
  critico: 'lideranca_cs_e_financeiro',
  pdd: 'financeiro',
}

/** SLA em dias por severidade, usado pelo motor de fila. */
export const SLA_DIAS_POR_SEVERIDADE: Record<Severidade, number | null> = {
  saudavel: null,
  atencao: 10,
  risco: 5,
  risco_alto: 3,
  critico: 2,
  pdd: 1,
}

/**
 * Uma conta em faixa ≥ risco gera UM item de trabalho, não um por vetor.
 *
 * A v1.0 permitia que o mesmo atraso de pagamento produzisse queda de score,
 * item de churn silencioso e escalonamento de cobrança — três notificações para
 * um fato. É assim que se ensina o time a silenciar a ferramenta.
 */
export const FAMILIA_GATILHO = 'churn_silencioso'

export function geraItemDeTrabalho(sev: Severidade): boolean {
  return sev !== 'saudavel'
}

/**
 * Limiares de engajamento — DEF-05.
 *
 * Quatro faixas, ancoradas no piso do segmento. A v1.0 previa um único limiar
 * ("qual queda, por quantos períodos?") para uma matriz que precisa de quatro.
 *
 * Calibração: medir continuamente o tempo entre entrada na faixa e cancelamento
 * real, por vetor. Se der poucos dias, o sinal não antecipa o suficiente para
 * caber ação e o limiar precisa ser mais sensível.
 */
export interface LimiaresEngajamento {
  /** Fração do piso do segmento abaixo da qual o engajamento é "baixo". */
  readonly fracaoPisoBaixo: number
  /** Fração do piso abaixo da qual é "nulo". */
  readonly fracaoPisoNulo: number
  /** Queda mínima, em pontos percentuais relativos, para "em queda". */
  readonly quedaRelativa: number
  /** Competências consecutivas de queda para confirmar "em queda". */
  readonly competenciasQueda: number
  /** Dias sem nenhuma transação que forçam "nulo". */
  readonly diasSemTransacaoNulo: number
}

export const LIMIARES_PROPOSTOS: LimiaresEngajamento = {
  fracaoPisoBaixo: 1.0,
  fracaoPisoNulo: 0.4,
  quedaRelativa: 0.15,
  competenciasQueda: 2,
  diasSemTransacaoNulo: 60,
}

export function faixaEngajamento(
  adesao30d: number,
  pisoSegmento: number,
  quedaRelativaObservada: number,
  competenciasEmQueda: number,
  diasSemTransacao: number,
  limiares: LimiaresEngajamento = LIMIARES_PROPOSTOS,
): FaixaEngajamento {
  if (diasSemTransacao >= limiares.diasSemTransacaoNulo) return 'nulo'
  if (pisoSegmento <= 0) return 'saudavel'

  const razao = adesao30d / pisoSegmento
  if (razao < limiares.fracaoPisoNulo) return 'nulo'
  if (razao < limiares.fracaoPisoBaixo) return 'baixo'
  if (
    quedaRelativaObservada >= limiares.quedaRelativa &&
    competenciasEmQueda >= limiares.competenciasQueda
  ) {
    return 'em_queda'
  }
  return 'saudavel'
}
