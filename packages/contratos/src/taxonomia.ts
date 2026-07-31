import type { Papel } from '@ops/auth'

/**
 * A taxonomia de cláusulas — e ela É o produto.
 *
 * Cada tipo existe porque alguém pergunta sobre ele, e cada tipo declara QUEM
 * PODE LER. Desconto negociado e histórico de conflito não podem ter a mesma
 * visibilidade que "tem telemedicina".
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A tentação, num projeto cujo objetivo é autonomia, é abrir tudo           │
 * │ internamente — é mais simples e maximiza o benefício declarado. Mas:      │
 * │                                                                           │
 * │  · desconto negociado exposto a toda a empresa vira problema na primeira  │
 * │    renegociação em que um cliente descobre a condição de outro;           │
 * │  · histórico de litígio circulando internamente é risco jurídico próprio. │
 * │                                                                           │
 * │ A saída NÃO é curadoria manual — ela recriaria o gargalo em outra forma,  │
 * │ com alguém do Jurídico decidindo o que entra no resumo de cada contrato.  │
 * │ É AUDIÊNCIA DECLARADA POR TIPO: definida uma vez aqui, aplicada           │
 * │ automaticamente em todo contrato, auditável.                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A regra de exibição que acompanha isto é igualmente importante: cláusula fora
 * da faixa do papel NÃO desaparece. Ela aparece com o tipo visível e o valor
 * oculto — "restrita, solicite ao Jurídico". Esconder a existência faria a pessoa
 * concluir que a cláusula não existe, e agir errado por isso.
 */

export type FaixaSigilo = 'aberta' | 'reservada' | 'restrita'

export type TipoClausula =
  | 'escopo_produto'
  | 'telemedicina'
  | 'uso_marca'
  | 'comunicacao_usuario'
  | 'sla'
  | 'renovacao'
  | 'reajuste'
  | 'aviso_previo'
  | 'customizacao'
  | 'obrigacoes'
  | 'excecao_comercial'
  | 'exclusividade'
  | 'faturamento'
  | 'lgpd'
  | 'foro'
  | 'multa'
  | 'conflito'
  | 'acordo'
  | 'outra'

/** Quem lê cada faixa. Definido uma vez, aplicado em todo contrato. */
export const PAPEIS_POR_FAIXA: Readonly<Record<FaixaSigilo, readonly Papel[]>> = {
  // Todos os papéis internos. `ops-dados` incluído: ele opera o pipeline e
  // precisa conseguir verificar de onde um valor veio.
  aberta: [
    'ops-csm',
    'ops-cs-lead',
    'ops-implantacao',
    'ops-comercial',
    'ops-financeiro',
    'ops-diretoria',
    'ops-admin',
    'ops-dados',
    'ops-juridico',
    'ops-marketing',
    'ops-produto',
  ],
  // CSM comum fica fora: condição comercial de uma conta vista por quem atende
  // outra é o caminho mais curto para um cliente descobrir o desconto do vizinho.
  reservada: ['ops-comercial', 'ops-cs-lead', 'ops-financeiro', 'ops-juridico', 'ops-diretoria'],
  // Litígio e acordo. `ops-admin` NÃO está aqui de propósito: administrar a
  // plataforma não é o mesmo que ter alçada sobre conflito jurídico.
  restrita: ['ops-juridico', 'ops-financeiro', 'ops-diretoria'],
}

export interface EspecificacaoClausula {
  readonly tipo: TipoClausula
  /** A pergunta que este tipo existe para responder. Aparece na tela. */
  readonly pergunta: string
  readonly rotulo: string
  readonly faixa: FaixaSigilo
  /** Forma do valor, para a tela saber como renderizar e validar. */
  readonly forma: 'enum' | 'booleano_escopo' | 'lista' | 'regra' | 'texto' | 'numero'
  /** Valores aceitos quando a forma é `enum`. */
  readonly valores?: readonly string[]
}

export const CLAUSULAS: readonly EspecificacaoClausula[] = [
  // ── Faixa aberta ──
  {
    tipo: 'escopo_produto',
    rotulo: 'Escopo do produto',
    pergunta: 'O que exatamente foi vendido?',
    faixa: 'aberta',
    forma: 'lista',
  },
  {
    tipo: 'telemedicina',
    rotulo: 'Telemedicina',
    pergunta: 'Tem Telemed? Com que escopo?',
    faixa: 'aberta',
    forma: 'booleano_escopo',
  },
  {
    tipo: 'uso_marca',
    rotulo: 'Uso de marca',
    pergunta: 'Podemos usar a marca do cliente em material e no app?',
    faixa: 'aberta',
    forma: 'enum',
    valores: ['livre', 'com_aprovacao', 'vedado'],
  },
  {
    tipo: 'comunicacao_usuario',
    rotulo: 'Comunicação com usuário',
    pergunta: 'Podemos falar com os colaboradores dele? Por quais canais?',
    faixa: 'aberta',
    forma: 'enum',
    valores: ['livre', 'opt_in', 'restrita', 'vedada'],
  },
  {
    tipo: 'sla',
    rotulo: 'SLA',
    pergunta: 'Que SLA foi prometido?',
    faixa: 'aberta',
    forma: 'regra',
  },
  {
    tipo: 'renovacao',
    rotulo: 'Renovação',
    pergunta: 'A renovação é automática ou exige ato?',
    faixa: 'aberta',
    forma: 'enum',
    valores: ['automatica', 'expressa'],
  },
  {
    tipo: 'reajuste',
    rotulo: 'Reajuste',
    pergunta: 'Por qual índice e em que mês reajusta?',
    faixa: 'aberta',
    forma: 'regra',
  },
  {
    tipo: 'aviso_previo',
    rotulo: 'Aviso prévio',
    pergunta: 'Quantos dias de aviso prévio para denunciar?',
    faixa: 'aberta',
    forma: 'numero',
  },
  {
    tipo: 'customizacao',
    rotulo: 'Customização',
    pergunta: 'Prometemos alguma customização?',
    faixa: 'aberta',
    forma: 'texto',
  },
  {
    tipo: 'obrigacoes',
    rotulo: 'Obrigações',
    pergunta: 'Que obrigações cada parte assumiu?',
    faixa: 'aberta',
    forma: 'texto',
  },
  // ── Faixa reservada ──
  {
    tipo: 'excecao_comercial',
    rotulo: 'Exceção comercial',
    pergunta: 'Há desconto ou condição fora do padrão?',
    faixa: 'reservada',
    forma: 'regra',
  },
  {
    tipo: 'exclusividade',
    rotulo: 'Exclusividade',
    pergunta: 'Há exclusividade de categoria ou região?',
    faixa: 'reservada',
    forma: 'regra',
  },
  {
    tipo: 'faturamento',
    rotulo: 'Faturamento',
    pergunta: 'Como e quando fatura? Por vida ou valor fixo?',
    faixa: 'reservada',
    forma: 'regra',
  },
  {
    tipo: 'lgpd',
    rotulo: 'LGPD',
    pergunta: 'Qual o papel no tratamento, e quais subprocessadores foram autorizados?',
    faixa: 'reservada',
    forma: 'regra',
  },
  {
    tipo: 'foro',
    rotulo: 'Foro',
    pergunta: 'Qual o foro e a lei aplicável?',
    faixa: 'reservada',
    forma: 'texto',
  },
  // ── Faixa restrita ──
  {
    tipo: 'multa',
    rotulo: 'Multa de rescisão',
    pergunta: 'Há multa de rescisão? Sobre qual base?',
    faixa: 'restrita',
    forma: 'regra',
  },
  {
    tipo: 'conflito',
    rotulo: 'Conflito',
    pergunta: 'Houve litígio ou notificação?',
    faixa: 'restrita',
    forma: 'texto',
  },
  {
    tipo: 'acordo',
    rotulo: 'Acordo',
    pergunta: 'Houve acordo, e em que termos?',
    faixa: 'restrita',
    forma: 'texto',
  },
  // ── Escape ──
  {
    tipo: 'outra',
    rotulo: 'Outra',
    pergunta: 'Exceção que ainda não virou tipo.',
    // A faixa é irrelevante aqui: a audiência vem do campo `audiencia_papeis`,
    // e o banco recusa gravar sem ela. Declarada como restrita para que um
    // esquecimento no código falhe fechado.
    faixa: 'restrita',
    forma: 'texto',
  },
]

const POR_TIPO = new Map(CLAUSULAS.map((c) => [c.tipo, c]))

export function especificacao(tipo: string): EspecificacaoClausula | undefined {
  return POR_TIPO.get(tipo as TipoClausula)
}

/**
 * A pessoa pode LER o valor desta cláusula?
 *
 * Falha fechado: tipo desconhecido devolve `false`. Um tipo novo que alguém
 * adicione no banco sem declarar na taxonomia fica ilegível até ser declarado — o
 * inverso (visível para todos por omissão) é a falha que ninguém percebe.
 */
export function podeLerValor(
  tipo: string,
  papeis: readonly Papel[],
  audienciaExplicita?: readonly string[] | null,
): boolean {
  // `outra` traz a própria audiência. Vale ela, e só ela.
  if (audienciaExplicita && audienciaExplicita.length > 0) {
    return papeis.some((p) => audienciaExplicita.includes(p))
  }
  const spec = especificacao(tipo)
  if (!spec) return false
  if (spec.tipo === 'outra') return false
  const permitidos = PAPEIS_POR_FAIXA[spec.faixa]
  return papeis.some((p) => permitidos.includes(p))
}

/** Os tipos cujo VALOR uma pessoa consegue ler. Para montar filtro de busca. */
export function tiposLegiveis(papeis: readonly Papel[]): TipoClausula[] {
  return CLAUSULAS.filter((c) => c.tipo !== 'outra' && podeLerValor(c.tipo, papeis)).map(
    (c) => c.tipo,
  )
}

/**
 * O texto que substitui o valor quando a pessoa não pode lê-lo.
 *
 * Nunca vazio e nunca ausente: o tipo continua visível, e a frase diz o caminho.
 * Esconder a existência da cláusula faria a pessoa concluir que ela não existe.
 *
 * A frase nomeia a FAIXA correta — `reservada` e `restrita` são conceitos
 * distintos neste produto, e chamar as duas de "restrita" ensinaria o vocabulário
 * errado a quem lê a tela todo dia.
 */
export function textoRestrito(tipo: string): string {
  const spec = especificacao(tipo)
  const faixa: FaixaSigilo = spec?.faixa ?? 'restrita'
  const nomes = PAPEIS_POR_FAIXA[faixa]
    // Admin e dados operam a plataforma; listá-los como destinatários mandaria
    // alguém pedir cláusula de contrato para quem cuida do pipeline.
    .filter((p) => p !== 'ops-admin' && p !== 'ops-dados')
    .map((p) => p.replace('ops-', ''))
    .join(', ')
  return `${faixa} — visível para ${nomes}. Solicite ao Jurídico.`
}
