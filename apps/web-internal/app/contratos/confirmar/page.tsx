import {
  CLAUSULAS,
  especificacao,
  filaDeConfirmacao,
  podeConfirmar,
  progresso,
} from '@ops/contratos'
import { Aviso, Badge, Btn, Card, Field, Select, Table, Vazio } from '@ops/ui'
import Link from 'next/link'
import { forbidden } from 'next/navigation'

import { acaoConfirmar } from './acoes'
import { Corpo, Topo } from '../../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T23 — Fila de confirmação de cláusulas.
 *
 * Transforma 21 colunas de planilha e uma pilha de PDFs em dado confiável, sem
 * parar a operação. A ordem é por MRR: com centenas de cláusulas propostas e tempo
 * limitado do Jurídico, conferir primeiro o contrato de R$ 70 mil é o que faz o
 * esforço valer.
 *
 * Confirmar exige o documento e o trecho. É a invariante do banco, e o formulário
 * a expõe: afirmar sem dizer onde está escrito é exatamente o que a ferramenta
 * existe para acabar.
 */

const REAIS = (c: string | null) =>
  c === null
    ? '—'
    : (Number(c) / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      })

function valorLegivel(v: Record<string, unknown> | null): string {
  if (!v) return '—'
  if (typeof v['valor'] === 'string') return v['valor'].replace(/_/g, ' ')
  const partes = Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${String(x)}`)
  return partes.length > 0 ? partes.join(' · ') : '—'
}

export default async function Confirmar({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  const id = await exigir((p) => temEscopo(p.contas), 'confirmação de cláusulas')
  if (!podeConfirmar(id)) forbidden()
  const q = await searchParams

  const tipos = CLAUSULAS.filter((c) => c.tipo !== 'outra').map((c) => c.tipo)
  const [fila, prog] = await Promise.all([filaDeConfirmacao(pool(), id, 50), progresso(pool(), tipos)])

  // Documentos de cada conta da fila, para o campo de procedência. Um SELECT só:
  // um por linha seriam 50 idas ao banco por uma informação pequena.
  const contas = [...new Set(fila.map((c) => c.accountId))]
  const { rows: docs } = contas.length
    ? await pool().query<{ id: string; account_id: string; titulo: string }>(
        `SELECT id, account_id, titulo FROM contracts.document
          WHERE account_id = ANY($1) ORDER BY account_id, tipo, versao DESC`,
        [contas],
      )
    : { rows: [] }
  const porConta = new Map<string, typeof docs>()
  for (const d of docs) porConta.set(d.account_id, [...(porConta.get(d.account_id) ?? []), d])

  const semResposta = prog.filter((p) => p.confirmadas === 0)

  return (
    <>
      <Topo
        href="/contratos"
        titulo="Confirmação de cláusulas"
        proposito="Ordenada por MRR — o contrato maior primeiro"
        acoes={<span className="text-[13px] text-ink-2">{fila.length} proposta(s) na fila</span>}
      />
      <Corpo className="grid gap-5">
        {q.erro && <Aviso tom="erro" papel="alert">{q.erro}</Aviso>}
        {q.ok && <Aviso tom="ok" papel="status">{q.ok}</Aviso>}

        {semResposta.length > 0 && (
          <Aviso tom="alerta">
            {semResposta.length} tipo(s) de cláusula sem nenhuma resposta confirmada:{' '}
            <strong className="font-semibold">
              {semResposta.map((p) => p.rotulo).join(', ')}
            </strong>
            . Enquanto estiverem vazios, a pergunta continua chegando ao Jurídico.
          </Aviso>
        )}

        <Card title="Fila de confirmação">
          {fila.length === 0 ? (
            <Vazio
              titulo="Nenhuma cláusula proposta."
              porque="A fila enche com a extração assistida sobre os PDFs e a planilha legada. Vazia significa que tudo o que foi extraído já foi conferido — ou que a extração ainda não rodou."
              acao={{ texto: 'Ver a consulta de contratos', href: '/contratos' }}
              className="border-0 p-0"
            />
          ) : (
            <ul className="grid gap-3">
              {fila.map((c) => {
                const spec = especificacao(c.tipo)
                const documentos = porConta.get(c.accountId) ?? []
                return (
                  <li key={c.id} className="rounded-md border border-line border-l-[3px] border-l-amber bg-surface-2 p-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Link
                        href={`/contratos/${c.accountId}`}
                        className="text-[13.5px] font-bold text-purple-700 hover:text-purple-500"
                      >
                        {c.conta}
                      </Link>
                      <span className="tabular-nums text-[12.5px] text-ink-3">
                        {REAIS(c.mrrCentavos)}/mês
                      </span>
                      <Badge>{c.rotulo}</Badge>
                      <span className="text-[13px] text-ink">{valorLegivel(c.valorEstruturado)}</span>
                      {c.diasParaVigencia !== null && c.diasParaVigencia < 120 && (
                        <span className="ml-auto text-[12.5px] font-semibold text-amber-700">
                          vence em {c.diasParaVigencia} d
                        </span>
                      )}
                    </div>
                    {spec && <p className="mt-1 text-[12px] text-ink-3">{spec.pergunta}</p>}
                    {c.texto && (
                      <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">
                        {c.texto}
                      </p>
                    )}

                    {/* Procedência obrigatória, exposta no formulário: confirmar é
                        afirmar que aquilo está escrito em algum lugar. */}
                    <form action={acaoConfirmar} className="mt-2.5 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={c.id} />
                      <div className="min-w-[14em]">
                        <Select label="Documento de origem" name="documentoId" required>
                          <option value="">selecione…</option>
                          {documentos.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.titulo}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="min-w-[12em] flex-1">
                        <Field label="Trecho" name="trecho" placeholder="cláusula 7.1" required />
                      </div>
                      <Btn type="submit">Confirmar</Btn>
                    </form>
                    {documentos.length === 0 && (
                      <p className="mt-1.5 text-[12px] text-red">
                        Esta conta não tem documento carregado. Sem documento não há procedência, e
                        sem procedência a cláusula não pode ser confirmada.
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title="Progresso da captação, por tipo">
          {/* Contas sem resposta, e não porcentagem: "nenhum contrato responde se
              podemos usar a marca" muda prioridade; "43% capturado" não. */}
          <Table
            cols={['Tipo', 'Pergunta', 'Confirmadas', 'Propostas', 'Contas sem resposta']}
            rows={prog.map((p) => [
              <span className="font-semibold">{p.rotulo}</span>,
              <span className="text-[12.5px] text-ink-3">{especificacao(p.tipo)?.pergunta}</span>,
              <span className="tabular-nums">{p.confirmadas}</span>,
              <span className="tabular-nums text-amber-700">{p.propostas || ''}</span>,
              <span className={p.ausentes > 0 ? 'tabular-nums text-red' : 'tabular-nums text-ink-3'}>
                {p.ausentes}
              </span>,
            ])}
          />
        </Card>
      </Corpo>
    </>
  )
}
