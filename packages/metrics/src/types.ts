/**
 * Tipos do dicionário de métricas.
 *
 * Doc 00, seção 6.5 · ADR-010.
 *
 * Este pacote é a ÚNICA implementação de cada número da plataforma. O gateway
 * interno, o gateway externo, o renderizador de PDF e o fechamento mensal
 * importam daqui. É o que transforma "nenhum número é calculado duas vezes" de
 * promessa em propriedade do build.
 */

/** Unidade de apresentação. Decide formatação, nunca cálculo. */
export type Unidade =
  | 'inteiro'
  | 'percentual'
  | 'centavos'
  | 'dias'
  | 'razao'
  | 'escala_0_100'
  | 'escala_1_5'

/** Granularidade mínima em que a métrica faz sentido. */
export type Granularidade = 'conta_dia' | 'conta_mes' | 'conta_atual' | 'base_mes'

/**
 * Estado do dado, sempre viaja com o valor.
 *
 * Doc 00, 9.3 — os cinco estados que toda tela precisa saber renderizar.
 * `parcial` e `defasado` existem porque a alternativa (exibir em silêncio, ou
 * repetir o último valor conhecido) é o que destrói confiança em BI.
 */
export type EstadoDado = 'ok' | 'defasado' | 'parcial' | 'suprimido' | 'em_verificacao'

export interface FonteRef {
  /** Identificador do ciclo de ingestão que trouxe o dado (C1..C12). */
  readonly ciclo: string
  /** Sistema de origem. */
  readonly fonte: string
}

/**
 * Definição de uma métrica.
 *
 * `dono` e `explicacao` são obrigatórios de propósito: métrica sem responsável
 * nomeado e sem frase legível por humano não entra no dicionário. É a regra que
 * a v1.0 do PRD estabelecia na governança e não aplicava nos próprios objetivos.
 */
export interface MetricDefinition {
  readonly id: string
  readonly nome: string
  /** Expressão SQL, avaliada sobre `metrics.daily_snapshot` salvo indicação. */
  readonly formula: string
  readonly unidade: Unidade
  readonly granularidade: Granularidade
  readonly fontes: readonly FonteRef[]
  /**
   * Dono da definição. Um papel ("Data Owner") ou uma pendência de decisão
   * ("DEF-01"), nunca vazio — ver doc 02, seção A.
   */
  readonly dono: string
  /** Versão da definição. Muda quando a fórmula muda; a série ganha quebra visível. */
  readonly versao: number
  /** Frase em linguagem comum, exibida ao clicar no número (requisito D6). */
  readonly explicacao: string
  /** Métrica que não pode ser exposta ao cliente sem supressão por k-anonimato. */
  readonly sensivel?: boolean
}

/**
 * Envelope de linhagem.
 *
 * Doc 00, 6.6. Toda resposta de métrica da API carrega este envelope, e o
 * componente `<Metric/>` o consome. É o que torna o requisito "clique em
 * qualquer número e veja de onde ele veio" automático, em vez de trabalho
 * repetido por tela.
 */
export interface Lineage<T = number | null> {
  readonly valor: T
  readonly metrica: string
  readonly versao_definicao: number
  readonly competencia: string
  readonly gerado_em: string
  readonly fontes: readonly (FonteRef & {
    readonly atualizado_em: string | null
    readonly status: 'ok' | 'defasado' | 'ausente'
  })[]
  readonly estado: EstadoDado
  /** Preenchido quando `estado === 'suprimido'`: quantas pessoas havia no recorte. */
  readonly n_base?: number
}
