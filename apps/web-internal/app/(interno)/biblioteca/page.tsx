import { gatilhosAmbiguos, gatilhosSemPlaybook, indice } from '@ops/success'
import { Aviso, Badge, Btn, Card, Field, Table, TextArea, Vazio } from '@ops/ui'
import Link from 'next/link'

import { salvar } from './acoes'
import { Corpo, Topo } from '../casca'
import { pool } from '../../../lib/db'
import { exigir } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T11 — Biblioteca de playbooks.
 *
 * Propósito único: permitir que CS mude o processo sem depender de deploy. Um
 * playbook que só muda com release fica errado por semanas, e o CSM aprende a
 * ignorá-lo e a fazer do jeito dele — que é o mesmo que não ter biblioteca.
 *
 * O editor está nesta tela de propósito, e não atrás de um botão: a barreira
 * para corrigir uma frase de processo tem que ser menor que a barreira para
 * mandar mensagem no grupo pedindo que alguém corrija.
 */

export default async function Biblioteca({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  // Quem muda o processo do time é quem responde pelo processo.
  await exigir((p) => p.configurar, 'biblioteca de playbooks')
  const q = await searchParams
  const [chaves, ambiguos, semPlaybook] = await Promise.all([
    indice(pool()),
    gatilhosAmbiguos(pool()),
    gatilhosSemPlaybook(pool()),
  ])

  return (
    <>
      <Topo
        href="/biblioteca"
        acoes={
          <span className="text-[13px] text-ink-2">
            {chaves.filter((c) => c.temVigente).length} de {chaves.length} no ar
          </span>
        }
      />
      <Corpo className="grid gap-5">
        {q.erro && <Aviso tom="erro" papel="alert">{q.erro}</Aviso>}
        {q.ok && <Aviso tom="ok" papel="status">{q.ok}</Aviso>}

        {ambiguos.length > 0 && (
          /* Não é erro de dado: são duas chaves diferentes dizendo servir ao mesmo
             gatilho. A fila escolhe a mais recente e segue funcionando; quem
             configurou é quem sabe qual das duas deveria valer. */
          <Aviso tom="alerta">
            {ambiguos.map((a) => `${a.gatilho} tem ${a.quantos} playbooks vigentes`).join(' · ')}.
            A fila usa o publicado mais recentemente — decida qual deve valer e despublique o outro.
          </Aviso>
        )}

        {semPlaybook.length > 0 && (
          /* A lacuna que mais custa: o gatilho já roteia trabalho e cada item
             nasce sem instrução. Gatilho em sombra não entra — ninguém está
             agindo sobre ele ainda. */
          <Aviso tom="alerta">
            {semPlaybook.length} gatilho(s) na fila do time sem playbook:{' '}
            <strong className="font-semibold">{semPlaybook.join(', ')}</strong>. Os itens deles
            nascem sem instrução, e o CSM improvisa a resposta.
          </Aviso>
        )}

        <Card title="Playbooks">
          {chaves.length === 0 ? (
            <Vazio
              titulo="Nenhum playbook ainda."
              porque="Sem playbook, o item de trabalho informa e não instrui: o CSM sabe que há um problema e improvisa a resposta. Comece pelo gatilho que mais gera item — hoje é o financeiro."
              className="border-0 p-0"
            />
          ) : (
            <Table
              cols={['Playbook', 'Gatilhos', 'Versões', 'Estado']}
              rows={chaves.map((c) => [
                <>
                  <Link
                    href={`/biblioteca/chave/${encodeURIComponent(c.chave)}`}
                    className="font-semibold text-purple-700 hover:text-purple-500"
                  >
                    {c.titulo}
                  </Link>
                  <span className="mt-0.5 block text-[11.5px] text-ink-3">{c.chave}</span>
                </>,
                <span className="flex flex-wrap gap-1">
                  {c.gatilhos.length === 0 ? (
                    <span className="text-[12px] text-ink-3">nenhum</span>
                  ) : (
                    c.gatilhos.map((g) => <Badge key={g}>{g}</Badge>)
                  )}
                </span>,
                <span className="tabular-nums">{c.versoes}</span>,
                c.temVigente ? (
                  <Badge tone="green">no ar</Badge>
                ) : (
                  <Badge tone="amber">só rascunho</Badge>
                ),
              ])}
            />
          )}
        </Card>

        <Card title="Novo playbook, ou nova versão de um existente">
          <form action={salvar} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Chave"
                name="chave"
                placeholder="cobranca-30d"
                pattern="[a-z0-9-]{3,60}"
                required
              />
              <Field label="Gatilhos" name="gatilhos" placeholder="G-01, G-02" />
            </div>
            <Field
              label="Título"
              name="titulo"
              placeholder="O que fazer, numa frase"
              minLength={8}
              required
            />
            <TextArea
              label="Conteúdo"
              name="conteudo"
              rows={10}
              required
              placeholder={
                'Escreva os passos na ordem em que se fazem, com o que registrar em cada um.\n' +
                'O CSM vai ler isto no meio de uma ligação: frases curtas, verbo primeiro.'
              }
              className="leading-relaxed"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Btn type="submit">Salvar rascunho</Btn>
              {/* Salvar não publica. Duas etapas de propósito: o texto de processo
                  se escreve em rascunho e se lê antes de virar o que o time segue. */}
              <span className="text-[12.5px] text-ink-3">
                Salvar cria uma versão nova e inativa. Publicar é o passo seguinte, na
                tela da chave.
              </span>
            </div>
          </form>
        </Card>

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          Versão nunca é sobrescrita. O item de trabalho aponta para a versão que valia quando
          ele foi criado — publicar a versão 3 em agosto não muda o que o CSM tinha em mãos ao
          fechar um item em março, e é isso que faz a pergunta{' '}
          <em>&ldquo;o processo foi seguido?&rdquo;</em> ter resposta.
        </p>
      </Corpo>
    </>
  )
}
