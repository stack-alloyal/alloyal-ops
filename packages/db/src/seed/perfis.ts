/**
 * Perfis de cliente sintético.
 *
 * A massa não existe para "ter dados": existe para que cada caso que o produto
 * precisa tratar apareça pelo menos uma vez. Um banco cheio de clientes
 * saudáveis não exercita nada — e é justamente nos casos de borda que a
 * interface costuma quebrar em produção.
 *
 * Cada perfil abaixo corresponde a uma decisão do produto que precisa ser vista
 * funcionando antes de haver dado real.
 */

export type PerfilId =
  | 'saudavel'
  | 'em_queda'
  | 'atraso_leve'
  | 'pdd'
  | 'churn_silencioso'
  | 'em_aviso'
  | 'recorte_pequeno'
  | 'cobertura_baixa'
  | 'sem_engajamento'
  | 'novo'

export interface Perfil {
  readonly id: PerfilId
  /** Por que este perfil existe na massa. */
  readonly exercita: string
  /** Fração da base cadastrada que usa o clube no mês. */
  readonly adesaoBase: number
  /**
   * Quebra na adesão nos últimos 30 dias, como fração.
   * −0.22 reproduz a queda de 22% que é o exemplo canônico da fila.
   */
  readonly quebra30d: number
  readonly diasAtraso: number
  readonly diasSemContato: number
  /** Vidas cadastradas sobre contratadas. */
  readonly cobertura: number
  /** Faixa de vidas contratadas. */
  readonly porte: 'micro' | 'pequeno' | 'medio' | 'grande'
  /** Falso simula fonte de engajamento ausente para esta conta. */
  readonly temEngajamento: boolean
  /** Meses desde a assinatura do contrato. */
  readonly mesesDeCasa: number
  /** Saída anunciada em curso. */
  readonly emAviso?: { readonly diasAtras: number; readonly avisoPrevioDias: number }
}

export const PERFIS: readonly Perfil[] = [
  {
    id: 'saudavel',
    exercita: 'o caso normal — sem ele não dá para saber como "bom" se parece',
    adesaoBase: 0.52,
    quebra30d: 0.02,
    diasAtraso: 0,
    diasSemContato: 9,
    cobertura: 0.96,
    porte: 'medio',
    temEngajamento: true,
    mesesDeCasa: 18,
  },
  {
    id: 'em_queda',
    exercita: 'o gatilho de queda de adesão e o item de trabalho canônico da fila',
    adesaoBase: 0.41,
    quebra30d: -0.22,
    diasAtraso: 0,
    diasSemContato: 12,
    cobertura: 0.94,
    porte: 'medio',
    temEngajamento: true,
    mesesDeCasa: 26,
  },
  {
    id: 'atraso_leve',
    exercita: 'o gatilho de 30 dias e o driver financeiro decaindo',
    adesaoBase: 0.44,
    quebra30d: -0.05,
    diasAtraso: 38,
    diasSemContato: 21,
    cobertura: 0.9,
    porte: 'pequeno',
    temEngajamento: true,
    mesesDeCasa: 14,
  },
  {
    id: 'pdd',
    exercita: 'a escada de inadimplência até a provisão, com gate do Financeiro',
    adesaoBase: 0.19,
    quebra30d: -0.3,
    diasAtraso: 104,
    diasSemContato: 47,
    cobertura: 0.82,
    porte: 'pequeno',
    temEngajamento: true,
    mesesDeCasa: 31,
  },
  {
    id: 'churn_silencioso',
    exercita: 'paga em dia e parou de usar — a célula que a matriz existe para pegar',
    adesaoBase: 0.06,
    quebra30d: -0.55,
    diasAtraso: 0,
    diasSemContato: 63,
    cobertura: 0.88,
    porte: 'medio',
    temEngajamento: true,
    mesesDeCasa: 22,
  },
  {
    id: 'em_aviso',
    exercita: 'os dois relógios do churn: conta perdida hoje, receita saindo em 3 meses',
    adesaoBase: 0.35,
    quebra30d: -0.12,
    diasAtraso: 0,
    diasSemContato: 4,
    cobertura: 0.93,
    porte: 'grande',
    temEngajamento: true,
    mesesDeCasa: 40,
    emAviso: { diasAtras: 15, avisoPrevioDias: 90 },
  },
  {
    id: 'recorte_pequeno',
    exercita: 'a supressão por k-anonimato no portal — abaixo de 5, o número não sai',
    adesaoBase: 0.5,
    quebra30d: 0,
    diasAtraso: 0,
    diasSemContato: 15,
    cobertura: 1,
    porte: 'micro',
    temEngajamento: true,
    mesesDeCasa: 5,
  },
  {
    id: 'cobertura_baixa',
    exercita: 'a alavanca que depende do cliente, e o gatilho de base não carregada',
    adesaoBase: 0.48,
    quebra30d: 0.03,
    diasAtraso: 0,
    diasSemContato: 6,
    cobertura: 0.52,
    porte: 'medio',
    temEngajamento: true,
    mesesDeCasa: 2,
  },
  {
    id: 'sem_engajamento',
    exercita: 'a renormalização: driver sem fonte sai da conta, não entra como zero',
    adesaoBase: 0.46,
    quebra30d: -0.03,
    diasAtraso: 0,
    diasSemContato: 17,
    cobertura: 0.91,
    porte: 'medio',
    temEngajamento: false,
    mesesDeCasa: 11,
  },
  {
    id: 'novo',
    exercita: 'conta em implantação: histórico curto e estados vazios que ensinam',
    adesaoBase: 0.22,
    quebra30d: 0.35,
    diasAtraso: 0,
    diasSemContato: 3,
    cobertura: 0.71,
    porte: 'pequeno',
    temEngajamento: true,
    mesesDeCasa: 1,
  },
]

/** Vidas contratadas por porte. Micro é pequeno de propósito: é o caso da supressão. */
export const VIDAS_POR_PORTE: Record<Perfil['porte'], readonly [number, number]> = {
  micro: [6, 14],
  pequeno: [80, 260],
  medio: [400, 1_400],
  grande: [2_000, 6_500],
}

/** Preço por vida, em centavos. Grande paga menos por vida — é o desconto de volume. */
export const PRECO_POR_VIDA_CENTAVOS: Record<Perfil['porte'], readonly [number, number]> = {
  micro: [1_600, 2_400],
  pequeno: [1_200, 1_900],
  medio: [900, 1_500],
  grande: [600, 1_100],
}

export const SETORES = [
  'indústria',
  'varejo',
  'saúde',
  'construção',
  'logística',
  'serviços',
  'educação',
  'agronegócio',
] as const

export const PORTE_LABEL: Record<Perfil['porte'], string> = {
  micro: 'micro',
  pequeno: 'pequeno',
  medio: 'medio',
  grande: 'grande',
}
