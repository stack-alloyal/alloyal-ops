import { listarCascatas, type Cascata } from '@ops/success'
import { Badge, Card, Kpi, Table, Vazio, cn } from '@ops/ui'

import { Corpo, Topo } from '../casca'
import { pool } from '../../lib/db'
import { exigir } from '../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * Cascata de receita e fechamento mensal.
 *
 * A cascata responde "de onde veio e para onde foi o MRR". A linha que faz esta
 * tela valer alguma coisa é a do NÃO ATRIBUÍDO: o MRR final é observado na base
 * de contratos, e os movimentos vêm do ledger — duas fontes independentes. O que
 * sobra entre elas aparece com nome próprio em vez de ser empurrado para churn,
 * porque um gráfico que fecha sempre é um gráfico que ninguém audita.
 *
 * Resíduo grande não é churn escondido: é captação faltando.
 */

const REAIS = (c: string) =>
  (Number(c) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  })

const PCT = (v: number | null) =>
  v === null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`

/**
 * A partir de quanto o resíduo deixa de ser arredondamento e vira problema.
 *
 * 0,5% do MRR inicial: abaixo disso é ruído de contrato entrando no meio do mês;
 * acima, alguma captação não está gravando evento, e o número da cascata passa a
 * depender de uma fonte só.
 */
const TOLERANCIA_RESIDUO = 0.005

function residuoPreocupa(c: Cascata): boolean {
  const ini = Number(c.mrrInicialCentavos)
  if (ini <= 0) return false
  return Math.abs(Number(c.naoAtribuidoCentavos)) / ini > TOLERANCIA_RESIDUO
}

/** Uma linha da cascata, com o sinal explícito. */
function Passo({
  rotulo,
  valor,
  sinal,
  destaque,
}: {
  rotulo: string
  valor: string
  sinal: '+' | '−' | ''
  destaque?: 'residuo' | 'total'
}) {
  const zero = Number(valor) === 0
  return (
    <tr
      className={cn(
        'border-b border-line last:border-0',
        // Linha zerada fica atenuada: numa cascata a maioria dos movimentos é
        // zero em qualquer mês, e destacá-los todos apaga o que de fato se moveu.
        zero && 'text-ink-4',
        destaque === 'residuo' && 'border-t border-dashed border-line-strong',
        destaque === 'total' && 'border-t-2 border-ink font-semibold',
      )}
    >
      <td className="w-full px-3 py-2">{rotulo}</td>
      <td className="px-2 py-2 text-right tabular-nums text-ink-3">{sinal}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{REAIS(valor)}</td>
    </tr>
  )
}

export default async function Receita() {
  // Receita não tem carteira: quem vê, vê a base inteira. A identidade não é
  // usada depois — o recorte desta tela é tudo ou nada.
  await exigir((p) => p.receita === 'base' || p.configurar, 'cascata de receita')
  const cascatas = await listarCascatas(pool(), 12)
  const atual = cascatas[0]

  if (!atual) {
    return (
      <>
        <Topo href="/receita" />
        <Corpo>
          <Vazio
            titulo="Nenhuma competência fechada ainda."
            porque="A cascata é calculada pelo ciclo mensal a partir do ledger de eventos de MRR e da base de contratos. Enquanto o ciclo C5 do HubSpot não estiver ligado, o ledger só recebe os eventos gerados aqui — encerramentos aprovados no fluxo de saídas."
            acao={{ texto: 'Ver o pipeline de dados', href: '/dados' }}
          />
        </Corpo>
      </>
    )
  }

  return (
    <>
      <Topo
        href="/receita"
        acoes={
          atual.estado === 'congelada' ? (
            <Badge tone="green">congelada por {atual.congeladoPor}</Badge>
          ) : (
            <Badge tone="amber">aberta — os números ainda podem mudar</Badge>
          )
        }
      />
      <Corpo className="grid gap-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            rotulo="MRR final"
            valor={REAIS(atual.mrrFinalCentavos)}
            nota={`${atual.contasIniciais + atual.contasNovas - atual.contasPerdidas} contas · ${atual.competencia.slice(0, 7)}`}
          />
          <Kpi
            rotulo="NRR"
            valor={PCT(atual.nrr)}
            nota="coorte inicial, sem cliente novo"
            {...(atual.nrr !== null ? { tom: atual.nrr >= 1 ? ('green' as const) : ('amber' as const) } : {})}
          />
          <Kpi rotulo="GRR" valor={PCT(atual.grr)} nota="sem o efeito de expansão" />
          <Kpi
            rotulo="Não atribuído"
            valor={REAIS(atual.naoAtribuidoCentavos)}
            nota={
              residuoPreocupa(atual)
                ? 'acima da tolerância — captação faltando'
                : 'dentro da tolerância'
            }
            {...(residuoPreocupa(atual) ? { tom: 'red' as const } : {})}
          />
        </div>

        <Card title={`Cascata de ${atual.competencia.slice(0, 7)}`} className="max-w-[36em]">
          <table className="w-full text-[13.5px]">
            <tbody>
              <Passo rotulo="MRR inicial" valor={atual.mrrInicialCentavos} sinal="" />
              <Passo rotulo="Novo" valor={atual.novoCentavos} sinal="+" />
              <Passo rotulo="Expansão" valor={atual.expansaoCentavos} sinal="+" />
              <Passo rotulo="Reativação" valor={atual.reativacaoCentavos} sinal="+" />
              <Passo rotulo="Contração" valor={atual.contracaoCentavos} sinal="−" />
              {/* Os dois churns separados: um é insatisfação, o outro é crédito, e
                  somá-los no mesmo balde apaga a diferença entre as duas conversas. */}
              <Passo rotulo="Churn pedido" valor={atual.churnPedidoCentavos} sinal="−" />
              <Passo
                rotulo="Churn por inadimplência"
                valor={atual.churnInadimplenciaCentavos}
                sinal="−"
              />
              <Passo rotulo="Ajuste" valor={atual.ajusteCentavos} sinal="+" />
              <Passo
                rotulo="Não atribuído"
                valor={atual.naoAtribuidoCentavos}
                sinal="+"
                destaque="residuo"
              />
              <Passo rotulo="MRR final" valor={atual.mrrFinalCentavos} sinal="" destaque="total" />
            </tbody>
          </table>
        </Card>

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          O MRR final é observado na base de contratos; os movimentos vêm do ledger. São duas
          fontes independentes, e o <strong className="font-semibold">não atribuído</strong> é a
          diferença entre elas — ele existe para aparecer. Empurrá-lo para churn faria a cascata
          fechar sempre, e um número que fecha por construção é um número que ninguém consegue
          auditar. Resíduo grande é sinal de captação faltando, não de churn escondido.
        </p>

        {cascatas.length > 1 && (
          <>
            <Card title={`Últimos ${cascatas.length} meses`}>
              <Table
                cols={['Competência', 'MRR final', 'NRR', 'GRR', 'Churn', 'Não atribuído', 'Estado']}
                rows={cascatas.map((c) => [
                  <span className="tabular-nums font-semibold">{c.competencia.slice(0, 7)}</span>,
                  <span className="tabular-nums">{REAIS(c.mrrFinalCentavos)}</span>,
                  <span className="tabular-nums">{PCT(c.nrr)}</span>,
                  <span className="tabular-nums">{PCT(c.grr)}</span>,
                  <>
                    <span className="tabular-nums">
                      {REAIS(
                        String(
                          Number(c.churnPedidoCentavos) + Number(c.churnInadimplenciaCentavos),
                        ),
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] text-ink-3">
                      {c.contasPerdidas} conta(s)
                    </span>
                  </>,
                  <span
                    className={cn('tabular-nums', residuoPreocupa(c) && 'font-semibold text-red')}
                  >
                    {REAIS(c.naoAtribuidoCentavos)}
                  </span>,
                  c.estado === 'congelada' ? (
                    <Badge tone="green">congelada</Badge>
                  ) : (
                    <Badge tone="amber">aberta</Badge>
                  ),
                ])}
              />
            </Card>
            <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
              Competência congelada não se corrige: a correção é um ajuste na competência corrente,
              com nota. É restrição de banco, e não combinado de processo, porque a alternativa é
              alguém recalcular um mês já apresentado ao board e ninguém descobrir.
            </p>
          </>
        )}
      </Corpo>
    </>
  )
}
