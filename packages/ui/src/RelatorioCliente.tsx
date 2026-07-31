import { cn, Table } from './base'

/**
 * O relatório do cliente, como conteúdo puro.
 *
 * Este componente é a razão de existir do requisito "PDF renderizado a partir do
 * MESMO componente da tela". Duas renderizações do mesmo relatório é como o PDF sai
 * com um número que a tela não mostrava — e a divergência só aparece quando o
 * cliente aponta.
 *
 * As props são declaradas ESTRUTURALMENTE, e não importadas de `@pulse/success`: assim
 * o pacote de interface não passa a depender de domínio, e o compilador continua
 * verificando porque `ConteudoRelatorio` satisfaz a forma. A dependência na direção
 * inversa — domínio conhecendo interface — é a que impede o mesmo cálculo de servir a
 * uma API depois.
 *
 * Nada aqui busca dado, formata moeda de outra praça ou conhece rota. É o que
 * permite que a mesma função rode dentro do Next e dentro de um renderizador de PDF
 * sem nenhum ajuste.
 */

export interface NumeroDoRelatorioProps {
  readonly metrica: string
  readonly rotulo: string
  readonly valor: number | null
  readonly unidade: 'percentual' | 'inteiro' | 'centavos'
  readonly variacao: number | null
}

export interface PontoDaEvolucaoProps {
  readonly competencia: string
  readonly adesao30d: number | null
  readonly coberturaCadastral: number | null
}

export interface ComparativoProps {
  readonly metrica: string
  readonly valor: number | null
  readonly p25: number | null
  readonly p50: number | null
  readonly p75: number | null
  readonly nEmpresas: number
  readonly suprimido: boolean
  readonly posicao: string | null
}

export interface AcaoDoClienteProps {
  readonly titulo: string
  readonly porque: string
  readonly numero: string
}

export interface ConteudoDoRelatorioProps {
  readonly competencia: string
  readonly razaoSocial: string
  readonly numeros: readonly NumeroDoRelatorioProps[]
  readonly evolucao: readonly PontoDaEvolucaoProps[]
  readonly comparativo: readonly ComparativoProps[]
  readonly acoes: readonly AcaoDoClienteProps[]
  readonly dadoParcial: boolean
}

const PCT = (v: number | null) =>
  v === null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`

const NUM = (v: number | null) => (v === null ? '—' : v.toLocaleString('pt-BR'))

const REAIS = (v: number | null) =>
  v === null
    ? '—'
    : (v / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      })

const POSICAO: Record<string, string> = {
  abaixo_p25: 'abaixo do primeiro quartil',
  entre_p25_p50: 'abaixo da mediana',
  entre_p50_p75: 'acima da mediana',
  acima_p75: 'acima do terceiro quartil',
}

const ROTULO_METRICA: Record<string, string> = {
  adesao_30d: 'Adesão em 30 dias',
  cobertura_cadastral: 'Base cadastrada',
}

function valorFormatado(n: NumeroDoRelatorioProps): string {
  return n.unidade === 'percentual' ? PCT(n.valor) : n.unidade === 'centavos' ? REAIS(n.valor) : NUM(n.valor)
}

/**
 * A variação, com sinal e sem juízo de valor exagerado.
 *
 * `null` vira "sem mês anterior" e não "0%": zero afirmaria estabilidade onde não há
 * base para saber, e o cliente leria "não mudou nada".
 */
function Variacao({ v }: { v: number | null }) {
  if (v === null) return <span className="text-[11px] text-ink-4">sem mês anterior</span>
  const pct = Math.round(v * 100)
  return (
    <span
      className={cn(
        'text-[11.5px] font-semibold',
        v > 0.02 ? 'text-green' : v < -0.02 ? 'text-red' : 'text-ink-3',
      )}
    >
      {v > 0 ? '+' : ''}
      {pct}% vs. mês anterior
    </span>
  )
}

export function RelatorioCliente({
  conteudo,
  frase,
  className,
}: {
  conteudo: ConteudoDoRelatorioProps
  /** A frase revisada pelo CSM. Nunca a gerada, quando há revisão. */
  frase: string | null
  className?: string
}) {
  const c = conteudo
  return (
    <article className={cn('grid gap-6', className)}>
      {/* ── A frase primeiro. É o que o gestor lê antes de olhar qualquer número, e
             a ordem na tela é a ordem da leitura. ── */}
      {frase && (
        <section>
          <p className="max-w-[75ch] text-[15px] leading-relaxed text-ink">{frase}</p>
        </section>
      )}

      {/* ── Bloco 1 ── */}
      <section>
        <h2 className="mb-2 text-[15px] font-bold tracking-[-0.01em] text-ink">O que aconteceu</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {c.numeros.map((n) => (
            <div key={n.metrica} className="rounded-lg border border-line bg-surface p-4">
              {/* `data-rotulo` existe para a folha de impressão reservar duas linhas
                  em todos os cartões: no A4 eles ficam estreitos, um rótulo que quebra
                  empurra o número para baixo e os três deixam de alinhar. */}
              <div
                data-rotulo
                className="text-[10.5px] font-semibold uppercase leading-tight tracking-[0.08em] text-ink-3"
              >
                {n.rotulo}
              </div>
              <div className="mt-1 text-[26px] font-bold leading-none tabular-nums text-ink">
                {valorFormatado(n)}
              </div>
              <div className="mt-1.5">
                <Variacao v={n.variacao} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Bloco 2 ──
             Tabela e não gráfico: o relatório vira PDF, e um gráfico exigiria uma
             segunda renderização — que é como o PDF passa a mostrar um número que a
             tela não mostrava. ── */}
      {c.evolucao.length > 1 && (
        <section>
          <h2 className="mb-2 text-[15px] font-bold tracking-[-0.01em] text-ink">
            Evolução · {c.evolucao.length} meses
          </h2>
          {/* `Table` em modo denso, e não uma tabela à mão: as classes do cabeçalho
              aqui eram cópia literal das do `Table`, e cópia diverge quando o
              componente muda — sem que ninguém abra o PDF para ver. */}
          <Table
            denso
            cols={['Mês', 'Adesão', 'Base cadastrada']}
            rows={c.evolucao.map((p) => [
              <span key="m" className="tabular-nums">
                {p.competencia}
              </span>,
              <span key="a" className="tabular-nums">
                {PCT(p.adesao30d)}
              </span>,
              <span key="b" className="tabular-nums">
                {PCT(p.coberturaCadastral)}
              </span>,
            ])}
          />
        </section>
      )}

      {/* ── Bloco 3 ── */}
      <section>
        <h2 className="mb-2 text-[15px] font-bold tracking-[-0.01em] text-ink">
          Comparativo com empresas semelhantes
        </h2>
        {c.comparativo.length === 0 ? (
          <p className="text-[13px] text-ink-3">
            Sem comparativo nesta competência.
          </p>
        ) : (
          <ul className="grid gap-2">
            {c.comparativo.map((x) => (
              <li key={x.metrica} className="rounded-md border border-line bg-surface-2 p-3">
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                  {ROTULO_METRICA[x.metrica] ?? x.metrica}
                </span>
                {x.suprimido ? (
                  /* Suprimido é EXPLICADO, não omitido — e sem dizer quantas empresas
                     há no recorte, porque esse número já é a informação que a
                     supressão protege. */
                  <p className="mt-1 text-[13px] text-ink-2">
                    Sem comparativo neste mês: o grupo de empresas de porte e setor semelhantes é
                    pequeno demais para uma comparação anônima.
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap items-baseline gap-3 text-[13.5px]">
                    <strong className="tabular-nums text-ink">{PCT(x.valor)}</strong>
                    <span className="text-ink-2">
                      {x.posicao ? (POSICAO[x.posicao] ?? x.posicao) : '—'} de{' '}
                      {/* O N declarado: comparação sem o tamanho do grupo é
                          comparação que o gestor não sabe defender numa reunião. */}
                      <strong className="font-semibold">{x.nEmpresas} empresas</strong>
                    </span>
                    <span className="tabular-nums text-[12px] text-ink-3">
                      p25 {PCT(x.p25)} · mediana {PCT(x.p50)} · p75 {PCT(x.p75)}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Bloco 4 ── */}
      {c.acoes.length > 0 && (
        <section>
          <h2 className="mb-2 text-[15px] font-bold tracking-[-0.01em] text-ink">
            O que depende de você
          </h2>
          <ul className="grid gap-2">
            {c.acoes.map((a) => (
              <li
                key={a.titulo}
                className="rounded-md border border-line border-l-[3px] border-l-purple-500 bg-surface-2 p-3"
              >
                <strong className="text-[13.5px] font-bold text-ink">{a.titulo}</strong>
                <span className="ml-2 tabular-nums text-[12.5px] font-semibold text-purple-700">
                  {a.numero}
                </span>
                <p className="mt-1 text-[13px] text-ink-2">{a.porque}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {c.dadoParcial && (
        /* Dito no corpo e não num rodapé: o cliente precisa ler isto antes de usar o
           número numa decisão dele. */
        <p className="rounded-md border border-amber/30 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700">
          Uma das fontes de dados não respondeu no fechamento deste mês. Os números acima podem ser
          revisados.
        </p>
      )}
    </article>
  )
}
