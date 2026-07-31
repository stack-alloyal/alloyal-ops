import { carregarFila, DESFECHOS, vePelaSombra, type ItemDaFila } from '@ops/success'
import { Badge, Btn, Field, TOM_POR_FAIXA, Vazio, cn } from '@ops/ui'
import { CalendarClock, ChevronRight } from 'lucide-react'
import Link from 'next/link'

import { fechar } from './acoes'
import { Corpo, Topo } from './casca'
import { pool } from '../lib/db'
import { exigir, temEscopo } from '../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T1 — Minha fila. A tela inicial é TRABALHO A FAZER, não painel (requisito D1).
 *
 * Aceite: três CSMs identificam a primeira ação em menos de 10 segundos. Tudo
 * nesta tela serve a isso — a ordem (vencido, prioridade, prazo, MRR), o motivo
 * em linguagem natural com o número dentro, e o fato de fechar caber em um
 * clique a partir da própria linha.
 *
 * O que NÃO está aqui é tão deliberado quanto o que está: nada de gráfico, nada
 * de score sem explicação. O CSM abre isto para agir, e todo pixel que não ajuda
 * a decidir a próxima ação atrapalha.
 */

const REAIS = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

/** O prazo em linguagem de gente: é o que decide a ordem de leitura. */
function prazoEmPalavras(dias: number): { texto: string; urgente: boolean; vencido: boolean } {
  if (dias < 0) return { texto: `venceu há ${-dias} d`, urgente: true, vencido: true }
  if (dias === 0) return { texto: 'vence hoje', urgente: true, vencido: false }
  if (dias === 1) return { texto: 'vence amanhã', urgente: true, vencido: false }
  return { texto: `em ${dias} d`, urgente: false, vencido: false }
}

const FAMILIA: Record<string, string> = {
  financeiro: 'Financeiro',
  adesao: 'Adesão',
  onboarding: 'Onboarding',
  churn_silencioso: 'Churn silencioso',
  relacionamento: 'Relacionamento',
  renovacao: 'Renovação',
  expansao: 'Expansão',
  operacional: 'Operacional',
}

const PRIORIDADE: Record<string, string> = {
  critica: 'Crítica',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
}

function Linha({ item, podeFechar }: { item: ItemDaFila; podeFechar: boolean }) {
  const p = prazoEmPalavras(item.diasParaPrazo)
  return (
    <li
      className={cn(
        'rounded-lg border border-line bg-surface p-[14px] shadow-sm transition-colors',
        // A barra à esquerda é o único elemento gráfico da tela: existe para a
        // varredura vertical funcionar, não para colorir.
        'border-l-[3px]',
        item.prioridade === 'critica' && 'border-l-red',
        item.prioridade === 'alta' && 'border-l-orange-500',
        item.prioridade === 'media' && 'border-l-amber',
        p.vencido && 'bg-red-50/40',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[14px] font-bold tracking-[-0.01em] text-ink">{item.conta}</span>
        {item.mrrCentavos && (
          <span className="tabular-nums text-[12.5px] text-ink-3" title="MRR do contrato vigente">
            {REAIS.format(Number(item.mrrCentavos) / 100)}/mês
          </span>
        )}
        {/* Cor nunca é o único portador de significado (D9): o rótulo vai junto. */}
        <Badge tone={TOM_POR_FAIXA[item.prioridade] ?? 'slate'}>
          {PRIORIDADE[item.prioridade] ?? item.prioridade}
        </Badge>
        <Badge>{FAMILIA[item.familia] ?? item.familia}</Badge>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1.5 tabular-nums text-[12.5px]',
            p.vencido ? 'font-semibold text-red' : p.urgente ? 'font-semibold text-orange-700' : 'text-ink-3',
          )}
        >
          <CalendarClock className="h-[14px] w-[14px]" />
          {p.texto}
        </span>
      </div>

      {/* O motivo é a tela inteira em uma frase. Se ele não bastar para decidir,
          o gatilho é que está mal escrito — não é a tela que precisa de gráfico. */}
      <p className="mt-2 text-[14px] text-ink">{item.motivo}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        <Link
          href={`/contas/${item.accountId}`}
          className="inline-flex items-center gap-1 text-[13px] font-semibold text-purple-700 hover:text-purple-500"
        >
          Abrir conta <ChevronRight className="h-[14px] w-[14px]" />
        </Link>
        <span className="tabular-nums text-[11.5px] text-ink-4">
          {item.gatilho}
          {/* "aberto há 0 d" é ruído: só diz algo quando o item está encalhando. */}
          {item.diasAberto > 0 && ` · aberto há ${item.diasAberto} d`}
        </span>
        {podeFechar && (
          <details className="ml-auto text-[13px]">
            <summary className="cursor-pointer select-none font-semibold text-ink-2 hover:text-ink">
              Fechar
            </summary>
            <form
              action={fechar}
              className="mt-2 grid gap-2 rounded-md border border-line bg-surface-2 p-3 md:min-w-[380px]"
            >
              <input type="hidden" name="id" value={item.id} />
              <Field name="nota" type="text" placeholder="O que aconteceu? (opcional)" maxLength={500} />
              <div className="flex flex-wrap gap-2">
                {DESFECHOS.map((d) => (
                  <Btn
                    key={d.valor}
                    type="submit"
                    variant={d.valor === 'resolvido' ? 'primary' : 'ghost'}
                    name="desfecho"
                    value={d.valor}
                    title={d.explica}
                  >
                    {d.rotulo}
                  </Btn>
                ))}
              </div>
              <p className="text-[12px] text-ink-3">
                O desfecho não é burocracia: <strong className="font-semibold">falso positivo</strong>{' '}
                é o único sinal que calibra o gatilho e impede a fila de virar ruído.
              </p>
            </form>
          </details>
        )}
      </div>
    </li>
  )
}

export default async function MinhaFila() {
  const id = await exigir((p) => temEscopo(p.fila), 'fila de trabalho')
  const fila = await carregarFila(pool(), id)

  const vencidos = fila.abertos.filter((i) => i.diasParaPrazo < 0).length

  return (
    <>
      <Topo
        href="/"
        titulo={fila.visaoDaBase ? 'Fila da base' : 'Minha fila'}
        acoes={
          fila.abertos.length > 0 ? (
            <span className="tabular-nums text-[13px] text-ink-2">
              {fila.abertos.length} {fila.abertos.length === 1 ? 'item' : 'itens'}
              {vencidos > 0 && (
                <>
                  {' · '}
                  <strong className="font-semibold text-red">{vencidos} vencido(s)</strong>
                </>
              )}
            </span>
          ) : undefined
        }
      />
      <Corpo>
        {fila.visaoDaBase && fila.abertos.length > 0 && (
          <p className="mb-3 text-[13px] text-ink-3">
            Você está vendo a base inteira, não só a sua carteira.
          </p>
        )}

        {fila.abertos.length === 0 ? (
          <Vazio
            titulo={
              fila.backlog.length > 0
                ? 'Nada aberto agora — o que existe está em backlog.'
                : 'Nenhum item na sua fila.'
            }
            porque={
              fila.backlog.length > 0
                ? 'O teto é de 12 itens por pessoa. O que passou disso esperou por prioridade e entra assim que você fechar algo.'
                : 'A fila é gerada uma vez por dia, depois da consolidação. Fila vazia é o estado normal de uma carteira saudável — não é um erro de carregamento.'
            }
            acao={{ texto: 'Ver o pipeline de dados', href: '/dados' }}
          />
        ) : (
          <ol className="grid gap-2">
            {fila.abertos.map((i) => (
              <Linha key={i.id} item={i} podeFechar />
            ))}
          </ol>
        )}

        {fila.backlog.length > 0 && (
          <details className="mt-7">
            <summary className="cursor-pointer select-none text-[13px] font-semibold text-ink-2 hover:text-ink">
              {fila.backlog.length} em backlog — acima do teto de 12 por pessoa
            </summary>
            {/* Separado, e não misturado: é a diferença entre uma fila de 12 e uma
                lista de tudo que está errado. Entra sozinho quando abrir vaga. */}
            <p className="mt-2 max-w-[70ch] text-[13px] text-ink-3">
              Estes itens são reais e continuam sendo avaliados. Eles sobem para a fila por
              prioridade assim que você fechar algo — não é preciso escolher aqui.
            </p>
            <ol className="mt-3 grid gap-2 opacity-75">
              {fila.backlog.map((i) => (
                <Linha key={i.id} item={i} podeFechar={false} />
              ))}
            </ol>
          </details>
        )}

        {vePelaSombra(id) && fila.sombra.length > 0 && (
          <details className="mt-7 border-t border-dashed border-line pt-5">
            <summary className="cursor-pointer select-none text-[13px] font-semibold text-ink-2 hover:text-ink">
              {fila.sombra.length} em modo sombra — não são trabalho do time
            </summary>
            <p className="mt-2 max-w-[70ch] text-[13px] text-ink-3">
              Gatilhos novos rodam 14 dias sem rotear item para ninguém. Esta lista existe para
              você julgar a precisão deles <em>antes</em> de gastar a atenção do time: se a
              maioria destes itens não pediria ação, o gatilho não deve ser promovido.
            </p>
            <ol className="mt-3 grid gap-2 opacity-75">
              {fila.sombra.map((i) => (
                <Linha key={i.id} item={i} podeFechar={false} />
              ))}
            </ol>
          </details>
        )}
      </Corpo>
    </>
  )
}
