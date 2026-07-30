/**
 * @ops/metrics — o dicionário de métricas da plataforma.
 *
 * ADR-010. Este pacote é a única implementação de cada número do Alloyal Ops.
 * O gateway interno, o gateway externo, o renderizador de PDF e a rotina de
 * fechamento mensal importam daqui. Nenhum deles recalcula.
 *
 * Importar este pacote registra o catálogo. Métrica duplicada, sem dono ou sem
 * explicação lança erro na importação — o build falha antes do deploy.
 */

export * from './types.js'
export * from './define.js'
export * from './score.js'
export * from './drivers.js'
export * from './lineage.js'
export * from './churn.js'
export * from './gatilhos.js'
export * from './catalog/conta.js'
export * from './catalog/receita.js'

// Efeito colateral proposital: registra o catálogo ao importar o pacote.
import './catalog/conta.js'
import './catalog/receita.js'
