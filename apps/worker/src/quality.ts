/**
 * As cinco verificações de qualidade.
 *
 * Doc do Ops, seção 09. Cada uma tem uma AÇÃO declarada, e as ações são
 * deliberadamente diferentes entre si — tratar toda falha de qualidade do mesmo
 * jeito é o que produz ou um sistema que trava por qualquer coisa, ou um que
 * publica qualquer coisa.
 */

export type AcaoQualidade =
  | 'nenhuma'
  /** A métrica derivada entra neutra e sinalizada. Nunca com o último valor. */
  | 'neutro_sinalizado'
  /** O snapshot é publicado marcado como incompleto, com a lacuna declarada. */
  | 'snapshot_parcial'
  /** Alarme, sem bloquear: variação real existe e precisa de olho humano. */
  | 'alarme'
  | 'alarme_critico'
  /** Vai para ops.excecao_referencia, com dono e payload. */
  | 'fila_excecao'

export interface Verificacao {
  readonly nome: 'frescor' | 'completude' | 'anomalia' | 'referencia' | 'reconciliacao'
  readonly passou: boolean
  readonly acao: AcaoQualidade
  readonly detalhe: string
}

/**
 * Frescor — a fonte respondeu dentro do prazo declarado?
 *
 * Fonte fora do prazo faz a métrica derivada entrar NEUTRA e SINALIZADA. Nunca
 * se mantém o último valor conhecido: é assim que um cliente que parou de ser
 * atendido continua parecendo saudável porque a integração caiu.
 */
export function verificarFrescor(
  fonte: string,
  atualizadoEm: Date | null,
  prazoMs: number,
  agora: Date,
): Verificacao {
  if (!atualizadoEm) {
    return {
      nome: 'frescor',
      passou: false,
      acao: 'neutro_sinalizado',
      detalhe: `${fonte}: nunca atualizada`,
    }
  }
  const atraso = agora.getTime() - atualizadoEm.getTime()
  if (atraso > prazoMs) {
    const horas = Math.round(atraso / 3_600_000)
    return {
      nome: 'frescor',
      passou: false,
      acao: 'neutro_sinalizado',
      detalhe: `${fonte}: ${horas} h sem atualizar (prazo ${Math.round(prazoMs / 3_600_000)} h)`,
    }
  }
  return { nome: 'frescor', passou: true, acao: 'nenhuma', detalhe: `${fonte}: em dia` }
}

/** Banda padrão da carga completa: ±20% contra a execução anterior. */
export const BANDA_COMPLETUDE = 0.2

/**
 * Completude — a contagem está na faixa esperada?
 *
 * Marca o snapshot como parcial; NÃO o bloqueia. Produto no ar sem número
 * nenhum é pior que número parcial e declarado — e bloquear tornaria a meta de
 * cobertura de sinal impossível por construção, já que basta uma fonte atrasar.
 *
 * A primeira execução não tem contra o que comparar e passa: exigir referência
 * inexistente travaria a carga inicial.
 */
export function verificarCompletude(
  linhas: number,
  linhasAnteriores: number | null,
  banda = BANDA_COMPLETUDE,
): Verificacao {
  if (linhasAnteriores === null || linhasAnteriores === 0) {
    return {
      nome: 'completude',
      passou: true,
      acao: 'nenhuma',
      detalhe: `${linhas} linhas · sem execução anterior para comparar`,
    }
  }
  const variacao = (linhas - linhasAnteriores) / linhasAnteriores
  if (Math.abs(variacao) > banda) {
    return {
      nome: 'completude',
      passou: false,
      acao: 'snapshot_parcial',
      detalhe: `${linhas} linhas contra ${linhasAnteriores} anteriores (${(variacao * 100).toFixed(1)}%, banda ±${banda * 100}%)`,
    }
  }
  return {
    nome: 'completude',
    passou: true,
    acao: 'nenhuma',
    detalhe: `${linhas} linhas · dentro da banda`,
  }
}

/**
 * Anomalia — a métrica saiu da própria série?
 *
 * Alarme, sem bloquear. Cliente que dobra de tamanho produz anomalia legítima,
 * e travar o dia por causa dela ensinaria o time a ignorar o alarme.
 *
 * Menos de 3 pontos de histórico não é série: não dá para afirmar desvio.
 */
export function verificarAnomalia(valor: number, serie: readonly number[], desvios = 3): Verificacao {
  if (serie.length < 3) {
    return { nome: 'anomalia', passou: true, acao: 'nenhuma', detalhe: 'série curta demais' }
  }
  const media = serie.reduce((a, b) => a + b, 0) / serie.length
  const variancia = serie.reduce((a, b) => a + (b - media) ** 2, 0) / serie.length
  const desvio = Math.sqrt(variancia)
  if (desvio === 0) {
    return {
      nome: 'anomalia',
      passou: valor === media,
      acao: valor === media ? 'nenhuma' : 'alarme',
      detalhe: `série constante em ${media}`,
    }
  }
  const z = Math.abs(valor - media) / desvio
  if (z > desvios) {
    return {
      nome: 'anomalia',
      passou: false,
      acao: 'alarme',
      detalhe: `${valor} está a ${z.toFixed(1)} desvios da média (${media.toFixed(1)})`,
    }
  }
  return { nome: 'anomalia', passou: true, acao: 'nenhuma', detalhe: `${z.toFixed(1)} desvios` }
}

/**
 * Referência — o registro casou com alguma conta?
 *
 * Vai para a fila de exceção, com o payload guardado. Nunca é descartado, e
 * nunca cria conta: descartar transforma erro de integração em número errado
 * silencioso, e criar produz três contas para o mesmo cliente.
 */
export function verificarReferencia(semConta: number, total: number): Verificacao {
  if (semConta === 0) {
    return { nome: 'referencia', passou: true, acao: 'nenhuma', detalhe: 'tudo resolvido' }
  }
  const fracao = total > 0 ? semConta / total : 1
  return {
    nome: 'referencia',
    passou: false,
    // Acima de 2% não é caso isolado: é mapeamento faltando em lote, e seguir
    // carregando só aumenta a fila. É o gatilho de risco declarado no PRD.
    acao: fracao > 0.02 ? 'alarme' : 'fila_excecao',
    detalhe: `${semConta} de ${total} sem conta (${(fracao * 100).toFixed(1)}%)`,
  }
}

/**
 * Reconciliação — o que está aqui bate com a origem?
 *
 * Divergência acima da tolerância é alarme CRÍTICO, não aviso: é o único sinal
 * que diz que um número já publicado está errado.
 */
export function verificarReconciliacao(
  valorOps: number,
  valorOrigem: number,
  tolerancia: number,
): Verificacao {
  const base = Math.abs(valorOrigem)
  const divergencia = base === 0 ? (valorOps === 0 ? 0 : 1) : Math.abs(valorOps - valorOrigem) / base
  if (divergencia > tolerancia) {
    return {
      nome: 'reconciliacao',
      passou: false,
      acao: 'alarme_critico',
      detalhe: `divergência de ${(divergencia * 100).toFixed(2)}% (tolerância ${(tolerancia * 100).toFixed(2)}%)`,
    }
  }
  return {
    nome: 'reconciliacao',
    passou: true,
    acao: 'nenhuma',
    detalhe: `divergência de ${(divergencia * 100).toFixed(2)}%`,
  }
}

/**
 * Consolida o veredito de um conjunto de verificações.
 *
 * A ação mais severa vence — e a ordem de severidade não é arbitrária: um dado
 * que precisa de gente acordada é mais grave que um snapshot parcial, que por
 * sua vez é mais grave que uma métrica que entrou neutra.
 */
const SEVERIDADE: Record<AcaoQualidade, number> = {
  nenhuma: 0,
  fila_excecao: 1,
  neutro_sinalizado: 2,
  snapshot_parcial: 3,
  alarme: 4,
  alarme_critico: 5,
}

export function vereditoQualidade(vs: readonly Verificacao[]): {
  readonly acao: AcaoQualidade
  readonly falhas: readonly Verificacao[]
} {
  const falhas = vs.filter((v) => !v.passou)
  const acao = falhas.reduce<AcaoQualidade>(
    (pior, v) => (SEVERIDADE[v.acao] > SEVERIDADE[pior] ? v.acao : pior),
    'nenhuma',
  )
  return { acao, falhas }
}
