import { carregarCarteira, listarRelatorios } from '@ops/success'
import { Aviso, Badge, Btn, Card, Field, Select, Table, Vazio } from '@ops/ui'
import Link from 'next/link'

import { acaoCompor, acaoDescartar } from './acoes'
import { Corpo, Topo } from '../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T4 — Relatório do cliente. O fim do PowerPoint.
 *
 * A lista existe para responder "quem ainda não recebeu o relatório deste mês", que
 * é a pergunta que o CSM tem no fim do mês — e por isso os pendentes vêm primeiro.
 *
 * Compor não envia. Três passos de propósito: montar, revisar a frase, enviar. O
 * segundo é o que impede a frase da máquina de sair sem ninguém ter lido, e o
 * terceiro congela os números — o cliente passa a ter uma cópia.
 */

const ESTADO: Record<string, { rotulo: string; tom: 'amber' | 'blue' | 'green' | 'slate' }> = {
  rascunho: { rotulo: 'Rascunho', tom: 'amber' },
  revisado: { rotulo: 'Revisado — pronto para enviar', tom: 'blue' },
  enviado: { rotulo: 'Enviado', tom: 'green' },
  descartado: { rotulo: 'Descartado', tom: 'slate' },
}

const DATA = (s: string | null) =>
  s === null ? '—' : new Date(s).toLocaleDateString('pt-BR', { dateStyle: 'short' })

/** A competência padrão: o mês anterior fechado, que é o que se relata. */
function mesAnterior(): string {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}

export default async function Relatorios({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  const id = await exigir((p) => temEscopo(p.contas), 'relatórios do cliente')
  const q = await searchParams

  const [relatorios, carteira] = await Promise.all([
    listarRelatorios(pool(), id),
    carregarCarteira(pool(), id),
  ])

  const comp = mesAnterior()
  const jaTem = new Set(
    relatorios.filter((r) => r.competencia.startsWith(comp)).map((r) => r.accountId),
  )
  const semRelatorio = carteira.contas.filter((c) => !jaTem.has(c.id))
  const pendentes = relatorios.filter((r) => r.estado === 'rascunho' || r.estado === 'revisado')

  return (
    <>
      <Topo
        href="/relatorios"
        titulo="Relatórios do cliente"
        proposito={`Competência de referência: ${comp}`}
        acoes={
          <span className="text-[13px] text-ink-2">
            {relatorios.filter((r) => r.estado === 'enviado').length} enviado(s) ·{' '}
            {pendentes.length} pendente(s)
          </span>
        }
      />
      <Corpo className="grid gap-5">
        {q.erro && <Aviso tom="erro" papel="alert">{q.erro}</Aviso>}
        {q.ok && <Aviso tom="ok" papel="status">{q.ok}</Aviso>}

        {semRelatorio.length > 0 && (
          <Aviso tom="alerta">
            {semRelatorio.length} conta(s) da sua carteira sem relatório de {comp}. O relatório é o
            que substitui o PowerPoint — e a conta que não recebe é a que só ouve falar da Alloyal
            quando algo dá errado.
          </Aviso>
        )}

        <Card title="Compor relatório">
          <form action={acaoCompor} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[18em]">
              <Select label="Cliente" name="accountId" required>
                <option value="">selecione…</option>
                {carteira.contas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.razaoSocial}
                    {jaTem.has(c.id) ? ' — já tem relatório deste mês' : ''}
                  </option>
                ))}
              </Select>
            </div>
            <Field label="Competência" name="competencia" type="month" defaultValue={comp} required />
            <Btn type="submit">Montar rascunho</Btn>
          </form>
          <p className="mt-3 max-w-[80ch] text-[12.5px] text-ink-3">
            Montar não envia. O rascunho traz os quatro blocos e uma frase de leitura automática —
            que é rascunho também: você conhece o contexto que o número não tem, e uma queda que veio
            de férias coletivas não é uma queda de interesse.
          </p>
        </Card>

        <Card title={`${relatorios.length} relatório(s)`}>
          {relatorios.length === 0 ? (
            <Vazio
              titulo="Nenhum relatório ainda."
              porque="O relatório do cliente é uma página com quatro blocos: o que aconteceu, a evolução de 12 meses, o comparativo anônimo com empresas de porte semelhante, e o que depende do cliente. Comece pela conta de maior MRR."
              acao={{ texto: 'Ver a carteira', href: '/carteira' }}
              className="border-0 p-0"
            />
          ) : (
            <Table
              cols={['Cliente', 'Competência', 'Estado', 'Revisão', 'Envio', '']}
              rows={relatorios.map((r) => {
                const e = ESTADO[r.estado]!
                return [
                  <Link
                    href={`/relatorios/${r.id}`}
                    className="font-semibold text-purple-700 hover:text-purple-500"
                  >
                    {r.conta}
                  </Link>,
                  <span className="tabular-nums">{r.competencia.slice(0, 7)}</span>,
                  <Badge tone={e.tom}>{e.rotulo}</Badge>,
                  <span className="text-[12.5px] text-ink-3">
                    {r.revisadoPor ? `${DATA(r.revisadoEm)} · ${r.revisadoPor}` : '—'}
                  </span>,
                  <span className="text-[12.5px] text-ink-3">
                    {r.enviadoEm ? `${DATA(r.enviadoEm)} · ${r.destinatario}` : '—'}
                  </span>,
                  r.estado === 'rascunho' || r.estado === 'revisado' ? (
                    <form action={acaoDescartar}>
                      <input type="hidden" name="id" value={r.id} />
                      <Btn type="submit" variant="ghost">
                        Descartar
                      </Btn>
                    </form>
                  ) : (
                    <span className="text-[12px] text-ink-4">—</span>
                  ),
                ]
              })}
            />
          )}
        </Card>

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          Relatório enviado <strong className="font-semibold">não muda</strong>. O cliente tem uma
          cópia, e recalcular os números faria &ldquo;vocês disseram 42%&rdquo; passar a exibir 38% —
          a conversa deixaria de ser sobre o clube e passaria a ser sobre a ferramenta. Para
          corrigir, o caminho é um relatório novo que diga o que mudou.
        </p>
      </Corpo>
    </>
  )
}
