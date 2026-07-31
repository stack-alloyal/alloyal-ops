import { buscarPorTipo, CLAUSULAS, especificacao, tiposLegiveis, type TipoClausula } from '@ops/contratos'
import { Aviso, Badge, Btn, Card, Field, Select, Table, Vazio, cn } from '@ops/ui'
import { Lock } from 'lucide-react'
import Link from 'next/link'

import { Corpo, Topo } from '../casca'
import { pool } from '../../lib/db'
import { exigir, temEscopo } from '../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T20 — Busca por tipo de cláusula. A tela que decide o projeto.
 *
 * É ela que faz Marketing responder sozinho se pode usar a marca do cliente, sem
 * abrir um pedido para o Jurídico. O objetivo do projeto inteiro é fazer sete
 * áreas pararem de perguntar ao Jurídico — e se a resposta não estiver aqui em
 * dois cliques, o gargalo continua.
 *
 * O filtro só oferece os tipos que a pessoa pode LER. Oferecer um tipo que ela não
 * lê produziria uma busca que sempre volta recusada, e ela concluiria que a
 * ferramenta não funciona.
 */

/** O valor de uma cláusula em texto legível, a partir do jsonb. */
function valorLegivel(v: Record<string, unknown> | null): string {
  if (!v) return '—'
  if (typeof v['valor'] === 'string') return v['valor'].replace(/_/g, ' ')
  const partes = Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${String(x)}`)
  return partes.length > 0 ? partes.join(' · ') : '—'
}

export default async function Contratos({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string; valor?: string }>
}) {
  const id = await exigir((p) => temEscopo(p.contas), 'consulta de contratos')
  const q = await searchParams

  const legiveis = tiposLegiveis(id.papeis)
  const tipo = (q.tipo ?? legiveis[0] ?? 'uso_marca') as TipoClausula
  const spec = especificacao(tipo)
  const resultado = await buscarPorTipo(pool(), id, tipo, {
    ...(q.valor ? { valor: q.valor } : {}),
  })

  return (
    <>
      <Topo
        href="/contratos"
        acoes={
          <span className="text-[13px] text-ink-2">
            {legiveis.length} de {CLAUSULAS.length - 1} tipos visíveis para o seu papel
          </span>
        }
      />
      <Corpo className="grid gap-5">
        <Card title="Buscar por tipo de cláusula">
          {/* GET e não Server Action: a busca é um endereço. Quem acha "quais
              contratos vedam comunicação" quer poder mandar o link para alguém. */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="min-w-[16em]">
              <Select label="Tipo de cláusula" name="tipo" defaultValue={tipo}>
                {/* Só o que a pessoa lê: oferecer o que ela não lê produziria uma
                    busca que sempre volta recusada. */}
                {legiveis.map((t) => (
                  <option key={t} value={t}>
                    {especificacao(t)?.rotulo}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-[14em] flex-1">
              <Field
                label="Contendo o valor"
                name="valor"
                type="text"
                defaultValue={q.valor ?? ''}
                placeholder="IGPM, vedado, telemed…"
              />
            </div>
            <Btn type="submit">Buscar</Btn>
          </form>
          {spec && (
            <p className="mt-3 text-[13px] text-ink-2">
              <strong className="font-semibold">{spec.rotulo}</strong> — {spec.pergunta}
              {spec.valores && (
                <span className="text-ink-3"> Valores: {spec.valores.join(' · ')}.</span>
              )}
            </p>
          )}
        </Card>

        {resultado.recusado ? (
          /* Recusa explícita, nunca lista vazia: "nenhum resultado" se leria como
             "nenhum contrato tem essa cláusula", e alguém agiria com base nisso. */
          <Aviso tom="alerta">
            <Lock className="mr-1 inline h-[14px] w-[14px]" />
            Este tipo de cláusula está fora da faixa do seu papel. Não é ausência de resultado —
            é restrição de leitura. Solicite ao Jurídico.
          </Aviso>
        ) : (
          <Card title={`${resultado.clausulas.length} contrato(s)`}>
            {resultado.clausulas.length === 0 ? (
              <Vazio
                titulo="Nenhum contrato responde a esta busca."
                porque={
                  q.valor
                    ? `Nenhuma cláusula de ${spec?.rotulo} vigente contém "${q.valor}". Tente sem o filtro de valor — pode ser que o termo esteja escrito de outra forma.`
                    : `Nenhuma cláusula de ${spec?.rotulo} foi registrada ainda. A captação começa pela fila de confirmação, ordenada por MRR.`
                }
                acao={{ texto: 'Ver a fila de confirmação', href: '/contratos/confirmar' }}
                className="border-0 p-0"
              />
            ) : (
              <Table
                cols={['Cliente', 'Valor', 'Procedência', 'Vigência', 'Estado']}
                rows={resultado.clausulas.map((c) => [
                  <Link
                    href={`/contratos/${c.accountId}`}
                    className="font-semibold text-purple-700 hover:text-purple-500"
                  >
                    {c.conta}
                  </Link>,
                  <span className={cn(c.restrito && 'text-ink-3')}>
                    {c.restrito ? c.avisoRestricao : valorLegivel(c.valorEstruturado)}
                  </span>,
                  c.restrito ? (
                    <span className="text-[12px] text-ink-4">—</span>
                  ) : (
                    <span className="text-[12.5px] text-ink-2">
                      {c.documentoTitulo ?? 'sem documento'}
                      {c.trecho && <span className="text-ink-3"> · {c.trecho}</span>}
                    </span>
                  ),
                  <span className="tabular-nums text-[12.5px]">
                    desde {c.validoDe}
                    {c.validoAte && ` até ${c.validoAte}`}
                  </span>,
                  /* Proposta aparece marcada: ela NÃO vale para decisão, e
                     esconder faria a pessoa concluir que o contrato é silencioso. */
                  c.estado === 'confirmada' ? (
                    <Badge tone="green">confirmada</Badge>
                  ) : (
                    <Badge tone="amber">proposta — não vale para decisão</Badge>
                  ),
                ])}
              />
            )}
          </Card>
        )}

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          A audiência é declarada por <strong className="font-semibold">tipo</strong> de cláusula,
          uma vez, e aplicada automaticamente em todo contrato. Cláusula fora da sua faixa aparece
          com o tipo visível e o valor oculto — esconder a existência faria você concluir que ela
          não existe, e agir errado por isso. O registro legal é sempre o documento assinado:
          divergência entre esta tela e o PDF é incidente, e o PDF prevalece.
        </p>
      </Corpo>
    </>
  )
}
