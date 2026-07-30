/**
 * Construção do envelope de linhagem.
 *
 * O tipo já existia; nada o produzia. Este arquivo é o que faz "nenhum número
 * sem procedência" deixar de ser uma frase de documento.
 *
 * A ideia é simples e vale para toda a plataforma: o valor nunca viaja sozinho.
 * Ele leva junto de onde veio, quando foi calculado, sob qual versão da
 * definição, e em que estado está. A interface consome isso e o requisito de
 * "clique no número e veja a fonte" passa a ser automático em vez de trabalho
 * repetido por tela.
 */

import { getMetric } from './define.js'
import type { EstadoDado, FonteRef, Lineage } from './types.js'

export interface StatusFonte extends FonteRef {
  readonly atualizado_em: string | null
  readonly status: 'ok' | 'defasado' | 'ausente'
}

export interface EntradaEnvelope {
  readonly metrica: string
  readonly valor: number | null
  readonly competencia: string
  readonly geradoEm: Date
  /** Estado de cada fonte que alimenta esta métrica, vindo da consolidação. */
  readonly fontes: readonly StatusFonte[]
  /** Tamanho do recorte, quando a métrica é exposta ao cliente. */
  readonly nBase?: number
  /** Incidente de dado aberto sobre esta métrica. */
  readonly emVerificacao?: boolean
  /** Mínimo de pessoas para o recorte ser exibido ao cliente. */
  readonly minimoRecorte?: number
}

export const MINIMO_RECORTE_PADRAO = 5

/**
 * Deriva o estado do dado a partir das fontes e do recorte.
 *
 * A ordem de precedência não é arbitrária:
 *
 *   em_verificacao  incidente aberto vence tudo — enquanto há dúvida declarada,
 *                   ninguém deve usar o número como se não houvesse;
 *   suprimido       o recorte é pequeno demais para ser exibido, e isso não é
 *                   um problema de qualidade, é uma decisão de proteção;
 *   ausente/parcial fonte que não entregou;
 *   defasado        entregou tarde.
 */
export function estadoDoDado(e: EntradaEnvelope): EstadoDado {
  if (e.emVerificacao) return 'em_verificacao'

  const minimo = e.minimoRecorte ?? MINIMO_RECORTE_PADRAO
  if (e.nBase !== undefined && e.nBase < minimo) return 'suprimido'

  if (e.fontes.some((f) => f.status === 'ausente')) return 'parcial'
  if (e.fontes.some((f) => f.status === 'defasado')) return 'defasado'
  return 'ok'
}

/**
 * Monta o envelope de uma métrica.
 *
 * Falha se a métrica não estiver no dicionário: número sem definição registrada
 * não deveria conseguir chegar à tela, e é melhor quebrar aqui do que exibir um
 * valor que ninguém sabe explicar.
 */
export function envelope(e: EntradaEnvelope): Lineage {
  const def = getMetric(e.metrica)
  const estado = estadoDoDado(e)

  // Recorte suprimido não carrega valor. É a mesma invariante que o banco impõe
  // em public_v — repetida aqui porque o envelope também é montado a partir de
  // dados internos, que não passam por aquela tabela.
  const valor = estado === 'suprimido' ? null : e.valor

  return {
    valor,
    metrica: def.id,
    versao_definicao: def.versao,
    competencia: e.competencia,
    gerado_em: e.geradoEm.toISOString(),
    fontes: e.fontes,
    estado,
    ...(e.nBase !== undefined ? { n_base: e.nBase } : {}),
  }
}

/**
 * Texto de explicação do estado, para a interface.
 *
 * Fica no dicionário e não na tela porque o mesmo estado precisa ser explicado
 * igual em todo lugar — inclusive no portal do cliente, onde quem lê não tem
 * contexto nenhum do que é um "ciclo" ou uma "fonte".
 */
export const EXPLICACAO_ESTADO: Record<EstadoDado, string | null> = {
  ok: null,
  defasado: 'A fonte deste número não atualizou no prazo. O valor é o da última carga completa.',
  parcial: 'Falta uma das fontes deste período. O número está incompleto e vai se ajustar.',
  suprimido:
    'Poucas pessoas neste recorte para mostrar o número sem identificar alguém. A partir de 5, ele aparece.',
  em_verificacao: 'Este número está sendo verificado. Evite usá-lo até a conferência terminar.',
}
