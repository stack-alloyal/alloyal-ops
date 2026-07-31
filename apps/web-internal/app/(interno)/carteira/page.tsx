import { carregarCarteira, resumir, type ContaDaCarteira } from '@pulse/success'
import { Aviso, Badge, Card, Kpi, TOM_POR_FAIXA, Table, Vazio, cn } from '@pulse/ui'
import Link from 'next/link'

import { Corpo, Topo } from '../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T3 — A carteira. A tela do "onde eu olho".
 *
 * A fila mostra 12 itens; a carteira tem 30 contas. As 18 que não geraram item hoje
 * não são invisíveis — são o trabalho que ainda não virou urgente, e é olhando para
 * elas que se evita que virem.
 *
 * A ordem é risco × receita, e é a decisão de produto desta tela: por faixa só, o
 * CSM começa por uma conta crítica de R$ 800 e deixa uma em risco de R$ 40 mil para
 * depois; por MRR só, começa pela maior mesmo saudável.
 */

const REAIS = (c: string | null) =>
  c === null
    ? '—'
    : (Number(c) / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      })

const PCT = (v: number | null) =>
  v === null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`

const FAIXA: Record<string, string> = {
  critico: 'Crítico',
  risco: 'Risco',
  atencao: 'Atenção',
  saudavel: 'Saudável',
  sem_sinal: 'Sem sinal',
}

const FAIXA_ATRASO = (d: number | null) =>
  d === null ? '—' : d === 0 ? 'em dia' : d < 31 ? '1–30 d' : d < 61 ? '31–60 d' : d < 91 ? '61–90 d' : '90+ d'

/** O nome da faixa e o tom, com o caso `null` tratado como o que é: desconhecido. */
function faixaDe(c: ContaDaCarteira) {
  const k = c.faixa ?? 'sem_sinal'
  return { rotulo: FAIXA[k] ?? k, tom: TOM_POR_FAIXA[k] ?? ('slate' as const) }
}

export default async function Carteira({
  searchParams,
}: {
  searchParams: Promise<{ faixa?: string }>
}) {
  const id = await exigir((p) => temEscopo(p.contas), 'carteira')
  const q = await searchParams

  const carteira = await carregarCarteira(pool(), id, {
    ...(q.faixa ? { faixa: q.faixa } : {}),
  })
  const r = resumir(carteira)

  return (
    <>
      <Topo
        href="/carteira"
        titulo={carteira.visaoDaBase ? 'Base de clientes' : 'Minha carteira'}
        acoes={
          <span className="tabular-nums text-[13px] text-ink-2">
            {r.total} conta(s) · {REAIS(r.mrrTotalCentavos)}/mês
          </span>
        }
      />
      <Corpo className="grid gap-5">
        {carteira.semSinal > 0 && (
          /* Conta sem sinal não é conta saudável: é conta sobre a qual não se sabe
             nada. Somá-la ao verde faria a carteira parecer melhor do que é. */
          <Aviso tom="alerta">
            {carteira.semSinal} conta(s) sem sinal calculado. Elas não são saudáveis — são
            desconhecidas, e por isso pesam como atenção na ordem desta lista.
          </Aviso>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {r.porFaixa.slice(0, 4).map((f) => (
            <Kpi
              key={f.faixa}
              rotulo={FAIXA[f.faixa] ?? f.faixa}
              valor={f.contas}
              nota={`${REAIS(f.mrrCentavos)}/mês`}
              {...(f.faixa === 'critico' || f.faixa === 'risco'
                ? { tom: 'red' as const }
                : f.faixa === 'atencao' || f.faixa === 'sem_sinal'
                  ? { tom: 'amber' as const }
                  : { tom: 'green' as const })}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <span className="text-ink-3">Filtrar:</span>
          <Link
            href="/carteira"
            className={cn(
              'rounded-sm px-2.5 py-1 font-semibold',
              !q.faixa ? 'bg-purple-50 text-purple-700' : 'text-ink-2 hover:bg-surface-2',
            )}
          >
            todas
          </Link>
          {['critico', 'risco', 'atencao', 'saudavel'].map((f) => (
            <Link
              key={f}
              href={`/carteira?faixa=${f}`}
              className={cn(
                'rounded-sm px-2.5 py-1 font-semibold',
                q.faixa === f ? 'bg-purple-50 text-purple-700' : 'text-ink-2 hover:bg-surface-2',
              )}
            >
              {FAIXA[f]}
            </Link>
          ))}
          <span className="ml-auto text-[12.5px] text-ink-3">
            {r.semItem} sem item aberto
            {r.parciais > 0 && ` · ${r.parciais} com dado parcial`}
            {r.comClausulaProposta > 0 && ` · ${r.comClausulaProposta} com cláusula não conferida`}
          </span>
        </div>

        <Card title={q.faixa ? `Faixa: ${FAIXA[q.faixa] ?? q.faixa}` : 'Ordenada por risco × receita'}>
          {carteira.contas.length === 0 ? (
            <Vazio
              titulo={q.faixa ? 'Nenhuma conta nesta faixa.' : 'Nenhuma conta na sua carteira.'}
              porque={
                q.faixa
                  ? 'O filtro não achou nada. Volte para "todas" para ver a carteira inteira — pode ser que a faixa esteja vazia hoje, e isso é boa notícia.'
                  : 'A carteira vem do campo de CSM em cada conta. Se você deveria ter contas aqui, é o cadastro que precisa de ajuste — não a tela.'
              }
              acao={{ texto: 'Ver a fila de trabalho', href: '/' }}
              className="border-0 p-0"
            />
          ) : (
            <Table
              cols={['Cliente', 'MRR', 'Faixa', 'Adesão', 'Cobertura', 'Atraso', 'Contato', 'Fila']}
              rows={carteira.contas.map((c) => {
                const f = faixaDe(c)
                return [
                  <>
                    <Link
                      href={`/contas/${c.id}`}
                      className="font-semibold text-purple-700 hover:text-purple-500"
                    >
                      {c.razaoSocial}
                    </Link>
                    <span className="mt-0.5 block text-[11.5px] text-ink-3">
                      {[c.setor, c.porte].filter(Boolean).join(' · ')}
                      {carteira.visaoDaBase && c.csmEmail && ` · ${c.csmEmail}`}
                      {/* Dado parcial marcado na linha: o número dela não é
                          comparável ao das outras, e não dizer isso convida à
                          comparação errada. */}
                      {c.competencia !== null && !c.completo && (
                        <span className="text-amber-700"> · dado parcial</span>
                      )}
                      {c.clausulasPropostas > 0 && (
                        <span className="text-amber-700">
                          {' · '}
                          {c.clausulasPropostas} cláusula(s) não conferida(s)
                        </span>
                      )}
                    </span>
                  </>,
                  <span className="tabular-nums">{REAIS(c.mrrCentavos)}</span>,
                  <>
                    <Badge tone={f.tom}>{f.rotulo}</Badge>
                    {c.scoreComposto !== null && (
                      <span className="mt-0.5 block tabular-nums text-[11.5px] text-ink-3">
                        {c.scoreComposto}
                        {c.scoreParcial && ' parcial'}
                      </span>
                    )}
                  </>,
                  <span className="tabular-nums">{PCT(c.adesao30d)}</span>,
                  <span className="tabular-nums">{PCT(c.coberturaCadastral)}</span>,
                  <span
                    className={cn(
                      'tabular-nums',
                      (c.diasAtrasoMax ?? 0) >= 90
                        ? 'font-semibold text-red'
                        : (c.diasAtrasoMax ?? 0) > 0
                          ? 'text-amber-700'
                          : 'text-ink-3',
                    )}
                  >
                    {FAIXA_ATRASO(c.diasAtrasoMax)}
                  </span>,
                  <span
                    className={cn(
                      'tabular-nums',
                      (c.diasDesdeUltimoContato ?? 0) > 60 ? 'text-amber-700' : 'text-ink-3',
                    )}
                  >
                    {c.diasDesdeUltimoContato === null ? '—' : `${c.diasDesdeUltimoContato} d`}
                  </span>,
                  c.itensAbertos > 0 ? (
                    <Link href="/" className="tabular-nums font-semibold text-purple-700">
                      {c.itensAbertos}
                    </Link>
                  ) : (
                    <span className="tabular-nums text-ink-4">—</span>
                  ),
                ]
              })}
            />
          )}
        </Card>

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          A ordem é <strong className="font-semibold">risco × receita</strong>. Por faixa só, uma
          conta crítica de R$ 800 apareceria antes de uma em risco de R$ 40 mil; por MRR só, a maior
          apareceria primeiro mesmo saudável. Nenhuma das duas responde &ldquo;qual conversa eu
          tenho hoje&rdquo;. As {r.semItem} contas sem item aberto são o que a fila não mostra:
          metade está bem, e a outra metade é onde o próximo problema nasce.
        </p>
      </Corpo>
    </>
  )
}
