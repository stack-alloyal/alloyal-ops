import { carregarFila, DESFECHOS, vePelaSombra, type ItemDaFila } from '@ops/success'
import { Vazio } from '@ops/ui'

import { fechar } from './acoes'
import { pool } from '../lib/db'
import { exigir, temEscopo } from '../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T1 — Minha fila. A tela inicial é TRABALHO A FAZER, não painel (requisito D1).
 *
 * Aceite: três CSMs identificam a primeira ação em menos de 10 segundos. Tudo
 * nesta tela serve a isso — a ordem (vencido, depois prioridade, depois prazo),
 * o motivo em linguagem natural com o número dentro, e o fato de fechar caber
 * em um clique a partir da própria linha.
 *
 * O que NÃO está aqui é tão deliberado quanto o que está: nada de gráfico, nada
 * de score sem explicação, nada de contagem agregada no topo. O CSM abre isto
 * para agir, e todo pixel que não ajuda a decidir a próxima ação atrapalha.
 */

const REAIS = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

/** O prazo em linguagem de gente: é o que decide a ordem de leitura. */
function prazoEmPalavras(dias: number): { texto: string; estado: string } {
  if (dias < 0) return { texto: `venceu há ${-dias} d`, estado: 'vencido' }
  if (dias === 0) return { texto: 'vence hoje', estado: 'hoje' }
  if (dias === 1) return { texto: 'vence amanhã', estado: 'proximo' }
  return { texto: `em ${dias} d`, estado: 'ok' }
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
    <li className="fila__item" data-prioridade={item.prioridade} data-prazo={p.estado}>
      <div className="fila__cabeca">
        <span className="fila__conta">{item.conta}</span>
        {item.mrrCentavos && (
          <span className="fila__mrr" title="MRR do contrato vigente">
            {REAIS.format(Number(item.mrrCentavos) / 100)}/mês
          </span>
        )}
        {/* Cor nunca é o único portador de significado (D9): o rótulo vai junto. */}
        <span className="fila__tag" data-prioridade={item.prioridade}>
          {PRIORIDADE[item.prioridade] ?? item.prioridade}
        </span>
        <span className="fila__tag">{FAMILIA[item.familia] ?? item.familia}</span>
        <span className="fila__prazo" data-prazo={p.estado}>
          {p.texto}
        </span>
      </div>

      {/* O motivo é a tela inteira em uma frase. Se ele não bastar para decidir,
          o gatilho é que está mal escrito — não é a tela que precisa de gráfico. */}
      <p className="fila__motivo">{item.motivo}</p>

      <div className="fila__rodape">
        <a href={`/contas/${item.accountId}`}>Abrir conta</a>
        <span className="fila__meta">
          {item.gatilho}
          {/* "aberto há 0 d" é ruído: só diz algo quando o item está encalhando. */}
          {item.diasAberto > 0 && ` · aberto há ${item.diasAberto} d`}
        </span>
        {podeFechar && (
          <details className="fila__fechar">
            <summary>Fechar</summary>
            <form action={fechar}>
              <input type="hidden" name="id" value={item.id} />
              <input
                name="nota"
                type="text"
                placeholder="O que aconteceu? (opcional)"
                maxLength={500}
              />
              <div className="fila__desfechos">
                {DESFECHOS.map((d) => (
                  <button key={d.valor} name="desfecho" value={d.valor} title={d.explica}>
                    {d.rotulo}
                  </button>
                ))}
              </div>
              <small>
                O desfecho não é burocracia: <strong>falso positivo</strong> é o único sinal
                que calibra o gatilho e impede a fila de virar ruído.
              </small>
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
    <section className="fila">
      <h1>{fila.visaoDaBase ? 'Fila da base' : 'Minha fila'}</h1>

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
        <>
          <p className="fila__resumo">
            {fila.abertos.length} {fila.abertos.length === 1 ? 'item' : 'itens'}
            {vencidos > 0 && (
              <>
                {' · '}
                <strong data-prazo="vencido">{vencidos} vencido(s)</strong>
              </>
            )}
            {fila.visaoDaBase && ' · você está vendo a base inteira, não só a sua carteira'}
          </p>
          <ol className="fila__lista">
            {fila.abertos.map((i) => (
              <Linha key={i.id} item={i} podeFechar />
            ))}
          </ol>
        </>
      )}

      {fila.backlog.length > 0 && (
        <details className="fila__backlog">
          <summary>{fila.backlog.length} em backlog — acima do teto de 12 por pessoa</summary>
          {/* Separado, e não misturado: é a diferença entre uma fila de 12 e uma
              lista de tudo que está errado. Entra sozinho quando abrir vaga. */}
          <p className="fila__nota">
            Estes itens são reais e continuam sendo avaliados. Eles sobem para a fila por
            prioridade assim que você fechar algo — não é preciso escolher aqui.
          </p>
          <ol className="fila__lista" data-atenuado="sim">
            {fila.backlog.map((i) => (
              <Linha key={i.id} item={i} podeFechar={false} />
            ))}
          </ol>
        </details>
      )}

      {vePelaSombra(id) && fila.sombra.length > 0 && (
        <details className="fila__sombra">
          <summary>{fila.sombra.length} em modo sombra — não são trabalho do time</summary>
          <p className="fila__nota">
            Gatilhos novos rodam 14 dias sem rotear item para ninguém. Esta lista existe para
            você julgar a precisão deles <em>antes</em> de gastar a atenção do time: se a
            maioria destes itens não pediria ação, o gatilho não deve ser promovido.
          </p>
          <ol className="fila__lista" data-atenuado="sim">
            {fila.sombra.map((i) => (
              <Linha key={i.id} item={i} podeFechar={false} />
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
