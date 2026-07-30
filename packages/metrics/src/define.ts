import type { MetricDefinition } from './types.js'

/**
 * Registro global de métricas.
 *
 * Chave é o `id`. Registrar duas vezes o mesmo id é erro em tempo de importação:
 * é exatamente o começo de "duas pessoas calculam diferente" que o doc 00, 6.5
 * existe para impedir.
 */
const registry = new Map<string, MetricDefinition>()

export function defineMetric(def: MetricDefinition): MetricDefinition {
  if (registry.has(def.id)) {
    throw new Error(
      `Métrica duplicada: "${def.id}". Cada número tem uma definição só (ADR-010).`,
    )
  }
  if (!def.dono.trim()) {
    throw new Error(`Métrica "${def.id}" sem dono. Ver doc 02, seção A.`)
  }
  if (!def.explicacao.trim()) {
    throw new Error(
      `Métrica "${def.id}" sem explicação. Requisito D6: todo número sabe se explicar.`,
    )
  }
  registry.set(def.id, def)
  return def
}

/** Todas as métricas registradas. Usado pelo catálogo da interface e pelos testes. */
export function allMetrics(): readonly MetricDefinition[] {
  return [...registry.values()]
}

export function getMetric(id: string): MetricDefinition {
  const found = registry.get(id)
  if (!found) throw new Error(`Métrica desconhecida: "${id}".`)
  return found
}

/**
 * Métricas cuja definição ainda depende de decisão pendente.
 *
 * O painel de governança mostra esta lista: número em produção cujo dono é uma
 * pendência é dívida visível, não silenciosa.
 */
export function metricsPendentes(): readonly MetricDefinition[] {
  return allMetrics().filter((m) => /^DEF-\d+/.test(m.dono))
}
