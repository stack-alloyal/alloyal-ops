import { listarRelatorios, type ConteudoRelatorio } from '@ops/success'
import { Aviso, Badge, Btn, Card, Field, RelatorioCliente, TextArea } from '@ops/ui'
import { FileBarChart, Lock, Printer } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { acaoEnviar, acaoRevisar } from '../acoes'
import { Corpo, Topo } from '../../casca'
import { pool } from '../../../../lib/db'
import { exigir, temEscopo } from '../../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * A página do relatório: o que o cliente vai ver, e a revisão antes de enviar.
 *
 * A prévia é o MESMO componente que o PDF renderiza — paridade por construção, não
 * por conferência. Duas renderizações diferentes do mesmo relatório é como o PDF sai
 * com um número que a tela não mostrava.
 *
 * A frase é editável até o envio, e as duas versões ficam gravadas: comparar o que a
 * máquina escreveu com o que a pessoa corrigiu é o único jeito de descobrir que a
 * geração erra sempre no mesmo ponto.
 */

export default async function Relatorio({ params }: { params: Promise<{ id: string }> }) {
  const identidade = await exigir((p) => temEscopo(p.contas), 'relatório do cliente')
  const { id } = await params

  // Sem consulta por id no módulo: a lista já aplica o recorte de carteira, e
  // acrescentar uma leitura por id que ignore o recorte seria abrir um caminho
  // paralelo — que é como um CSM lê o relatório de outra carteira pela URL.
  const todos = await listarRelatorios(pool(), identidade)
  const r = todos.find((x) => x.id === id)
  if (!r) notFound()

  const c = r.conteudo as ConteudoRelatorio | null
  const enviado = r.estado === 'enviado'
  const podeRevisar = r.estado === 'rascunho' || r.estado === 'revisado'

  return (
    <>
      <Topo
        href="/relatorios"
        icone={FileBarChart}
        titulo={r.conta}
        proposito={`relatório de ${r.competencia.slice(0, 7)}`}
        acoes={
          <span className="flex items-center gap-2">
            {enviado && (
              <Badge tone="green">
                enviado a {r.destinatario} em{' '}
                {new Date(String(r.enviadoEm)).toLocaleDateString('pt-BR')}
              </Badge>
            )}
            {r.estado === 'revisado' && <Badge tone="blue">revisado — pronto para enviar</Badge>}
            {r.estado === 'rascunho' && <Badge tone="amber">rascunho</Badge>}
            {r.estado !== 'rascunho' && (
              <Link
                href={`/relatorios/${r.id}/imprimir`}
                target="_blank"
                className="inline-flex items-center gap-1 text-[13px] font-semibold text-purple-700 hover:text-purple-500"
              >
                <Printer className="h-[14px] w-[14px]" />
                Versão de impressão
              </Link>
            )}
            <Link
              href={`/contas/${r.accountId}`}
              className="text-[13px] font-semibold text-purple-700 hover:text-purple-500"
            >
              Cliente 360 →
            </Link>
          </span>
        }
      />
      <Corpo className="grid gap-5">
        {enviado && (
          <Aviso tom="ok">
            <Lock className="mr-1 inline h-[14px] w-[14px]" />
            Este relatório está congelado. O cliente tem uma cópia dos números abaixo, e por isso
            eles não mudam mesmo que a métrica seja recalculada. Para corrigir algo, componha um
            relatório novo que diga o que mudou.
          </Aviso>
        )}

        {c === null ? (
          <Aviso tom="alerta">
            Este relatório não tem conteúdo montado. Volte à lista e componha de novo.
          </Aviso>
        ) : (
          <>
            {c.dadoParcial && (
              <Aviso tom="alerta">
                O snapshot de {c.competencia.slice(0, 7)} saiu parcial: uma das fontes não respondeu
                no fechamento. A frase abaixo já diz isso ao cliente — não remova.
              </Aviso>
            )}

            {/* Os quatro blocos vêm do MESMO componente que o PDF renderiza.
                Duas renderizações do mesmo relatório é como o PDF sai com um número
                que a tela não mostrava — e a divergência só aparece quando o cliente
                aponta. A frase não entra aqui porque na tela ela é editável. */}
            <RelatorioCliente conteudo={c} frase={null} />
          </>
        )}

        {/* ── A frase, e a revisão ── */}
        <Card title="A frase que o cliente lê primeiro">
          {podeRevisar ? (
            <form action={acaoRevisar} className="grid gap-3">
              <input type="hidden" name="id" value={r.id} />
              <TextArea
                label="Revise antes de enviar — você conhece o contexto que o número não tem"
                name="frase"
                rows={5}
                minLength={40}
                required
                defaultValue={r.fraseFinal ?? r.fraseGerada ?? ''}
                className="leading-relaxed"
              />
              <div className="flex flex-wrap items-center gap-3">
                <Btn type="submit">
                  {r.estado === 'revisado' ? 'Salvar revisão' : 'Revisar e congelar'}
                </Btn>
                <span className="text-[12.5px] text-ink-3">
                  Revisar congela os números: a partir daí eles não mudam mesmo que a métrica seja
                  recalculada.
                </span>
              </div>
            </form>
          ) : (
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">
              {r.fraseFinal}
            </p>
          )}

          {/* As duas frases ficam. A divergência entre elas mostra onde a geração
              erra sempre — e é a única forma de melhorá-la. */}
          {r.fraseGerada && r.fraseFinal && r.fraseGerada !== r.fraseFinal && (
            <details className="mt-3 text-[12.5px]">
              <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">
                ver a frase que a máquina escreveu
              </summary>
              <p className="mt-2 rounded-md border border-dashed border-line bg-surface-2 p-3 leading-relaxed text-ink-3">
                {r.fraseGerada}
              </p>
            </details>
          )}
        </Card>

        {r.estado === 'revisado' && (
          <Card title="Enviar">
            <form action={acaoEnviar} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={r.id} />
              <div className="min-w-[18em]">
                <Field
                  label="E-mail do gestor"
                  name="destinatario"
                  type="email"
                  required
                  placeholder="rh@cliente.com.br"
                />
              </div>
              <Btn type="submit" variant="danger">
                Enviar e congelar definitivamente
              </Btn>
            </form>
            <p className="mt-3 max-w-[80ch] text-[12.5px] text-ink-3">
              O envio do e-mail em si depende de integração que ainda não existe. O que este passo
              grava é a prova de <em>que</em> foi enviado, <em>para quem</em> e <em>com que
              números</em> — e é essa prova que sustenta a conversa três meses depois.
            </p>
          </Card>
        )}
      </Corpo>
    </>
  )
}
