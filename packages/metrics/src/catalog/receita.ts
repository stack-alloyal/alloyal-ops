import { defineMetric } from '../define.js'

/**
 * Métricas de receita recorrente.
 *
 * Doc 01, seção 5.5.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ `mrr_centavos` é DERIVADO do ledger de eventos (`fact.mrr_event`),      │
 * │ nunca lido do campo do HubSpot.                                         │
 * │                                                                          │
 * │ ADR-012. O PRD v1.0 dizia simultaneamente que o HubSpot é a fonte de     │
 * │ MRR e que o Ops passa a ser a fonte de verdade dos eventos de MRR —      │
 * │ dois sistemas autoritativos, sem sincronização e sem alarme. O campo do  │
 * │ HubSpot é espelho, e divergência acima de 1% é alarme diário.            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const LEDGER = { ciclo: 'C5', fonte: 'ops' } as const

/**
 * Tipos de evento de MRR.
 *
 * `reativacao` e `ajuste` não existiam na v1.0 e são obrigatórios:
 * - `reativacao`: conta que saiu da base ativa por PDD e voltou a pagar;
 * - `ajuste`: correção após o congelamento do fechamento, lançada na competência
 *   corrente (o passado não é reescrito — doc 00, 6.7).
 */
export const TIPOS_EVENTO_MRR = [
  'novo',
  'expansao',
  'contracao',
  'churn_pedido',
  'churn_inadimplencia',
  'reativacao',
  'ajuste',
] as const

export type TipoEventoMrr = (typeof TIPOS_EVENTO_MRR)[number]

export const mrr = defineMetric({
  id: 'mrr_centavos',
  nome: 'MRR',
  formula: `(
    SELECT COALESCE(SUM(valor_centavos), 0)
    FROM fact.mrr_event e
    WHERE e.account_id = s.account_id
      AND e.competencia <= s.competencia
  )`,
  unidade: 'centavos',
  granularidade: 'conta_mes',
  fontes: [LEDGER],
  dono: 'Data Owner',
  versao: 1,
  explicacao:
    'Receita recorrente mensal, somada a partir do histórico de eventos de contrato. Não é lida do campo do HubSpot: o Ops é a fonte de verdade e o HubSpot é espelho.',
  sensivel: true,
})

/**
 * Cascata de Revenue Flows.
 *
 * A identidade abaixo tem que fechar. Quando não fecha, a diferença aparece como
 * `nao_atribuido` e NUNCA é empurrada para churn — doc 00, 6.1, princípio 5.
 * Número que fecha por construção é número que ninguém confia.
 */
export const CASCATA_MRR = [
  'mrr_inicial',
  'novo',
  'expansao',
  'contracao',
  'churn_pedido',
  'churn_inadimplencia',
  'reativacao',
  'ajuste',
  'nao_atribuido',
  'mrr_final',
] as const

export const nrr = defineMetric({
  id: 'nrr',
  nome: 'NRR',
  formula: `mrr_final_coorte::numeric / NULLIF(mrr_inicial_coorte, 0)`,
  unidade: 'percentual',
  granularidade: 'base_mes',
  fontes: [LEDGER],
  dono: 'DEF-04',
  versao: 1,
  explicacao:
    'Receita retida e expandida da coorte de clientes que já existiam no início do período. Clientes novos não entram — eles inflariam o indicador e esconderiam contração.',
  sensivel: true,
})

export const grr = defineMetric({
  id: 'grr',
  nome: 'GRR',
  formula: `(mrr_inicial_coorte - contracao - churn_total)::numeric / NULLIF(mrr_inicial_coorte, 0)`,
  unidade: 'percentual',
  granularidade: 'base_mes',
  fontes: [LEDGER],
  dono: 'Data Owner',
  versao: 1,
  explicacao:
    'Receita retida sem contar expansão. Mostra quanto da base se sustenta sozinha, sem o efeito de upsell.',
  sensivel: true,
})

export const churnReceita = defineMetric({
  id: 'churn_receita',
  nome: 'Churn de receita',
  formula: `churn_total::numeric / NULLIF(mrr_inicial_coorte, 0)`,
  unidade: 'percentual',
  granularidade: 'base_mes',
  fontes: [LEDGER],
  dono: 'DEF-02',
  versao: 1,
  explicacao:
    'Receita perdida no período sobre a receita do início. Publicado sempre ao lado do churn de contas — um sem o outro esconde se a empresa perde muitos clientes pequenos ou poucos grandes.',
  sensivel: true,
})

export const churnLogo = defineMetric({
  id: 'churn_logo',
  nome: 'Churn de contas',
  formula: `contas_perdidas::numeric / NULLIF(contas_iniciais, 0)`,
  unidade: 'percentual',
  granularidade: 'base_mes',
  fontes: [LEDGER],
  dono: 'DEF-02',
  versao: 1,
  explicacao: 'Quantidade de clientes perdidos no período sobre a quantidade no início.',
  sensivel: true,
})

/**
 * A métrica executiva do churn silencioso.
 *
 * Quebrada pelos dois vetores de propósito: permite à diretoria separar problema
 * de produto (desengajamento) de problema de crédito (inadimplência). Somados,
 * escondem os dois — e as respostas são diferentes.
 */
export const mrrEmChurnSilencioso = defineMetric({
  id: 'mrr_em_churn_silencioso',
  nome: 'MRR em churn silencioso',
  formula: `(
    SELECT COALESCE(SUM(m.mrr_centavos), 0)
    FROM metrics.silent_churn_flag f
    JOIN metrics.account_mrr m USING (account_id)
    WHERE f.competencia = $competencia
      AND f.severidade IN ('risco', 'risco_alto', 'critico', 'pdd')
  )`,
  unidade: 'centavos',
  granularidade: 'base_mes',
  fontes: [LEDGER, { ciclo: 'C12', fonte: 'ops' }],
  dono: 'DEF-05',
  versao: 1,
  explicacao:
    'Receita recorrente de clientes que ainda não cancelaram mas já pararam de ser clientes, quebrada entre desengajamento e inadimplência.',
  sensivel: true,
})

export const ttft = defineMetric({
  id: 'ttft_dias',
  nome: 'Time to first transaction',
  formula: `(primeira_transacao_em::date - contrato_inicio::date)`,
  unidade: 'dias',
  granularidade: 'conta_atual',
  fontes: [{ ciclo: 'C1', fonte: 'replica' }, { ciclo: 'C4', fonte: 'hubspot' }],
  dono: 'Data Owner',
  versao: 1,
  explicacao:
    'Dias entre a assinatura do contrato e a primeira transação da base do cliente. É a medida de quanto tempo a implantação leva para produzir valor real.',
})
