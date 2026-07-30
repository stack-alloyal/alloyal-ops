import type { EstadoDado, Lineage } from '@ops/metrics'

/**
 * O componente de número da plataforma.
 *
 * Doc 00, 9.3 · requisitos D6 e D10.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NENHUMA tela renderiza número cru. Toda métrica passa por aqui.           │
 * │                                                                            │
 * │ Isso resolve dois requisitos de uma vez, e resolve por construção em vez   │
 * │ de por disciplina:                                                         │
 * │                                                                            │
 * │  D6 — todo número sabe dizer fórmula, fonte, ciclo e horário. O envelope   │
 * │       de linhagem vem da API junto com o valor; não há trabalho por tela.  │
 * │                                                                            │
 * │  D10 — os cinco estados de dado são visíveis. Um número defasado, parcial  │
 * │        ou suprimido NUNCA aparece igual a um número íntegro.               │
 * │                                                                            │
 * │ A alternativa — cada tela formatando seu número — é como duas telas passam │
 * │ a mostrar o mesmo indicador com arredondamento diferente, e é o começo da  │
 * │ conversa em que ninguém confia no relatório.                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export interface MetricProps {
  readonly dados: Lineage
  /** Fórmula e explicação vêm do dicionário (`getMetric`). */
  readonly explicacao: string
  readonly formula?: string
  readonly unidade: 'inteiro' | 'percentual' | 'centavos' | 'dias' | 'razao' | 'escala_0_100'
  readonly rotulo?: string
}

const ROTULO_ESTADO: Record<EstadoDado, string | null> = {
  ok: null,
  defasado: 'dado defasado',
  parcial: 'período incompleto',
  suprimido: 'recorte pequeno',
  em_verificacao: 'em verificação',
}

/** Texto que aparece no lugar do valor quando não há valor a mostrar. */
const TEXTO_SEM_VALOR: Record<EstadoDado, string> = {
  ok: '—',
  defasado: '—',
  parcial: '—',
  // Nunca vazio e nunca zero: o gestor de um cliente pequeno concluiria que o
  // clube não funciona. Explicar a regra é parte do produto (doc 00, 13).
  suprimido: 'poucos usuários',
  em_verificacao: 'verificando',
}

export function formatar(
  valor: number | null,
  unidade: MetricProps['unidade'],
): string | null {
  if (valor === null) return null
  switch (unidade) {
    case 'percentual':
      return `${(valor * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
    case 'centavos':
      // Acima de mil reais, sem centavos: casa decimal em valor grande é ruído.
      return (valor / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: Math.abs(valor) >= 100_000 ? 0 : 2,
      })
    case 'dias':
      return `${valor.toLocaleString('pt-BR')} ${valor === 1 ? 'dia' : 'dias'}`
    case 'razao':
      return valor.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
    default:
      return valor.toLocaleString('pt-BR')
  }
}

export function Metric({ dados, explicacao, formula, unidade, rotulo }: MetricProps) {
  const formatado = formatar(dados.valor, unidade)
  const rotuloEstado = ROTULO_ESTADO[dados.estado]

  const titulo = [
    explicacao,
    formula ? `Fórmula: ${formula}` : null,
    `Fonte: ${dados.fontes.map((f) => `${f.fonte} (${f.ciclo})`).join(', ')}`,
    `Competência: ${dados.competencia}`,
    `Calculado em: ${new Date(dados.gerado_em).toLocaleString('pt-BR')}`,
    `Definição v${dados.versao_definicao}`,
    dados.estado === 'suprimido' && dados.n_base !== undefined
      ? `Recorte com ${dados.n_base} pessoas: abaixo do mínimo de 5, o número não é exibido para proteger quem usa o clube.`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span className="ops-metric" data-estado={dados.estado} data-metrica={dados.metrica}>
      {rotulo ? <span className="ops-metric__rotulo">{rotulo}</span> : null}
      <button type="button" className="ops-metric__valor" title={titulo} aria-describedby={undefined}>
        <span style={{ fontFamily: 'var(--ops-font-num)' }}>
          {formatado ?? TEXTO_SEM_VALOR[dados.estado]}
        </span>
        {/* Cor não é o único portador de significado (D9): o estado é texto. */}
        {rotuloEstado ? <small className="ops-metric__estado"> · {rotuloEstado}</small> : null}
      </button>
    </span>
  )
}
