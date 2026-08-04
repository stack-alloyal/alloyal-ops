import { agendaEmPalavras, atrasado, ciclosNaTela, historicoDeExecucoes } from '@pulse/config'
import { Aviso, Badge, Btn, Card, Table } from '@pulse/ui'
import { AlertTriangle, CheckCircle2, Clock, MinusCircle, XCircle } from 'lucide-react'
import Link from 'next/link'

import { CorpoDeConfiguracao } from '../submenu'
import { Topo } from '../../casca'
import { dispararCiclo } from '../acoes'
import { exigir } from '../../../../lib/guarda'
import { pool } from '../../../../lib/db'

export const dynamic = 'force-dynamic'

const DATA = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})

/** Duração legível. Segundos até 90s, depois minutos — 340s não se lê de cabeça. */
function duracao(seg: number | null): string {
  if (seg === null) return '—'
  if (seg < 90) return `${seg}s`
  const m = Math.floor(seg / 60)
  return `${m}min ${seg % 60}s`
}

/**
 * Sincronização: os ciclos, a agenda de cada um e o histórico de cada carga.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A TELA NÃO TEM BANCO PRÓPRIO, e é decisão.                                 │
 * │                                                                            │
 * │ Ela lê `ops.cycle_declaration` (escrita pelo worker na partida) e           │
 * │ `ops.cycle_run` (escrita pelo executor a cada rodada). Um painel de pipeline │
 * │ com tabela própria pode divergir do que de fato roda — e painel que mente   │
 * │ sobre o pipeline é pior que painel nenhum, porque ninguém vai conferir.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O QUE ESTA TELA NÃO FAZ: mudar a agenda.                                   │
 * │                                                                            │
 * │ A agenda vive em `defineCycle`, no código, junto do contrato que gera as     │
 * │ verificações de qualidade. Editá-la pela tela criaria DUAS agendas — a       │
 * │ declarada e a efetiva — e a divergência apareceria como "o snapshot saiu na  │
 * │ hora errada", meses depois. Mudar cadência é mudança de código, com revisão.│
 * │                                                                            │
 * │ O que a tela dá é o que a operação precisa sem o dev: VER o estado, LER o    │
 * │ erro e RODAR AGORA.                                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function Sincronizacao({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; ciclo?: string }>
}) {
  await exigir((p) => p.configurar, 'sincronização')
  const q = await searchParams
  const agora = new Date()

  const ciclos = await ciclosNaTela(pool())
  const historico = await historicoDeExecucoes(pool(), {
    ...(q.ciclo ? { ciclo: q.ciclo } : {}),
    limite: 60,
  })

  const implementados = ciclos.filter((c) => c.implementado)
  const atrasados = implementados.filter((c) => atrasado(c, agora))
  const falhando = implementados.filter((c) => c.falhasSeguidas > 0)

  const selo = (c: (typeof ciclos)[number]) => {
    if (!c.implementado) return <Badge tone="slate">declarado</Badge>
    if (c.ultimoStatus === 'rodando') return <Badge tone="blue">rodando</Badge>
    if (c.falhasSeguidas > 0)
      return <Badge tone="red">{c.falhasSeguidas} falha(s) seguidas</Badge>
    if (atrasado(c, agora)) return <Badge tone="amber">atrasado</Badge>
    if (c.ultimoStatus === 'ok') return <Badge tone="green">ok</Badge>
    return <Badge tone="slate">nunca rodou</Badge>
  }

  return (
    <>
      <Topo
        href="/configuracoes"
        titulo="Sincronização"
        proposito="os ciclos, a agenda e o histórico de cada carga"
      />
      <CorpoDeConfiguracao atual="/configuracoes/sincronizacao">
        {q.erro && (
          <Aviso tom="erro" papel="alert">
            {q.erro}
          </Aviso>
        )}
        {q.ok && (
          <Aviso tom="ok" papel="status">
            {q.ok}
          </Aviso>
        )}

        {atrasados.length > 0 && (
          <Aviso tom="alerta">
            {atrasados.length} ciclo(s) sem carga bem-sucedida há mais de 26h:{' '}
            <strong className="font-semibold">{atrasados.map((c) => c.id).join(', ')}</strong>. Numa
            agenda diária, isso significa que o número da tela é de anteontem.
          </Aviso>
        )}
        {falhando.length > 0 && (
          <Aviso tom="erro" papel="alert">
            {falhando.length} ciclo(s) falhando desde a última carga boa. O erro da última
            tentativa está na tabela abaixo — ele é o texto que o executor recebeu, sem tradução.
          </Aviso>
        )}

        <Card title={`Ciclos · ${implementados.length} de ${ciclos.length} implementados`}>
          <Table
            cols={['Ciclo', 'Agenda', 'Estado', 'Última carga', 'Volume', '']}
            vazio={
              <>
                Nenhum ciclo declarado. O worker escreve as declarações na partida — se está vazio,
                ele não subiu.
              </>
            }
            rows={ciclos.map((c) => [
              <>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">{c.id}</span>
                  <Badge tone="slate">{c.fonte}</Badge>
                  <span className="text-[11.5px] text-ink-4">{c.fase}</span>
                </div>
                <div className="mt-0.5 text-[12.5px] text-ink-3">{c.descricao}</div>
              </>,
              <>
                <div className="text-[13px] text-ink">{agendaEmPalavras(c.agenda)}</div>
                {/* O cron cru fica à vista: a frase é conveniência, o cron é a verdade. */}
                <div className="mt-0.5 font-mono text-[11px] text-ink-4">{c.agenda ?? '—'}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">{c.metodo}</div>
              </>,
              <>
                {selo(c)}
                {c.ultimoErro && (
                  <div className="mt-1 max-w-[280px] break-words text-[11.5px] leading-snug text-red">
                    {c.ultimoErro.slice(0, 180)}
                  </div>
                )}
              </>,
              <>
                <div className="text-[13px] text-ink">
                  {c.ultimaEm ? DATA.format(c.ultimaEm) : '—'}
                </div>
                {c.ultimoSucessoEm && c.ultimoStatus !== 'ok' && (
                  <div className="mt-0.5 text-[11.5px] text-ink-3">
                    último sucesso: {DATA.format(c.ultimoSucessoEm)}
                  </div>
                )}
                <div className="mt-0.5 text-[11.5px] text-ink-3">
                  {duracao(c.duracaoSegundos)}
                </div>
              </>,
              <div className="text-[12.5px] text-ink-2">
                {c.linhasLidas === null ? (
                  '—'
                ) : (
                  <>
                    {c.linhasLidas.toLocaleString('pt-BR')} lidas
                    <div className="text-ink-3">
                      {(c.linhasGravadas ?? 0).toLocaleString('pt-BR')} gravadas
                    </div>
                  </>
                )}
              </div>,
              <div className="flex items-center justify-end gap-2">
                <Link
                  href={`/configuracoes/sincronizacao?ciclo=${c.id}`}
                  className="text-[12.5px] font-semibold text-purple-700 hover:text-purple-500"
                >
                  histórico
                </Link>
                {c.implementado && (
                  /* Sem motivo obrigatório aqui, ao contrário das outras ações de
                     configuração: rodar um ciclo não muda regra nem acesso — só
                     antecipa uma carga que aconteceria de qualquer forma. Exigir
                     justificativa para isso ensinaria a escrever "asdf". */
                  <form action={dispararCiclo}>
                    <input type="hidden" name="ciclo" value={c.id} />
                    <Btn type="submit" variant="ghost">
                      Rodar agora
                    </Btn>
                  </form>
                )}
              </div>,
            ])}
          />
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            A agenda vive no código, junto do contrato do ciclo — mudá-la pela tela criaria duas
            agendas, a declarada e a efetiva, e a divergência apareceria meses depois como
            &ldquo;o número saiu na hora errada&rdquo;. Aqui se vê o estado, se lê o erro e se roda
            agora.
          </p>
        </Card>

        <Card
          title={
            q.ciclo
              ? `Histórico de ${q.ciclo} · ${historico.length} execução(ões)`
              : `Histórico · últimas ${historico.length} execuções`
          }
          actions={
            q.ciclo ? (
              <Link
                href="/configuracoes/sincronizacao"
                className="text-[13px] font-semibold text-purple-700 hover:text-purple-500"
              >
                ver todos os ciclos
              </Link>
            ) : undefined
          }
        >
          <Table
            cols={['Quando', 'Ciclo', 'Status', 'Duração', 'Volume', 'Detalhe']}
            vazio={
              <>
                Nenhuma execução registrada{q.ciclo ? ` para ${q.ciclo}` : ''}. O executor grava uma
                linha por rodada, inclusive quando falha.
              </>
            }
            rows={historico.map((e) => {
              const seg =
                e.terminadoEm === null
                  ? null
                  : Math.round((e.terminadoEm.getTime() - e.iniciadoEm.getTime()) / 1000)
              const Icone =
                e.status === 'ok'
                  ? CheckCircle2
                  : e.status === 'falha'
                    ? XCircle
                    : e.status === 'rodando'
                      ? Clock
                      : MinusCircle
              const cor =
                e.status === 'ok'
                  ? 'text-green'
                  : e.status === 'falha'
                    ? 'text-red'
                    : 'text-ink-3'
              return [
                <span className="whitespace-nowrap text-[12.5px] text-ink">
                  {DATA.format(e.iniciadoEm)}
                </span>,
                <span className="font-semibold text-ink">{e.ciclo}</span>,
                <span className={`flex items-center gap-1.5 text-[12.5px] ${cor}`}>
                  <Icone className="h-[14px] w-[14px]" />
                  {e.status}
                </span>,
                <span className="text-[12.5px] text-ink-2">{duracao(seg)}</span>,
                <span className="whitespace-nowrap text-[12.5px] text-ink-2">
                  {e.linhasLidas === null
                    ? '—'
                    : `${e.linhasLidas.toLocaleString('pt-BR')} → ${(e.linhasGravadas ?? 0).toLocaleString('pt-BR')}`}
                </span>,
                <div className="max-w-[380px] text-[11.5px] leading-snug">
                  {e.erro ? (
                    <span className="break-words text-red">{e.erro.slice(0, 240)}</span>
                  ) : e.detalhe ? (
                    /* O detalhe cru, e não uma seleção de campos: é o que o ciclo
                       reportou, e o dia em que ele reportar algo novo esse algo
                       aparece sem ninguém mexer aqui. */
                    <span className="break-words text-ink-3">
                      {Object.entries(e.detalhe)
                        .filter(([, v]) => v !== null && v !== 0 && v !== false)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(' · ')
                        .slice(0, 240) || '—'}
                    </span>
                  ) : (
                    <span className="text-ink-4">—</span>
                  )}
                </div>,
              ]
            })}
          />
        </Card>

        <Card title="Como ler esta tela">
          <ul className="grid gap-2 text-[13px] leading-relaxed text-ink-2">
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
              <span>
                <strong className="font-semibold text-ink">atrasado</strong> é mais de 26h sem carga
                bem-sucedida numa agenda diária. A folga de 2h absorve atraso normal — não é alarme
                falso.
              </span>
            </li>
            <li className="flex gap-2">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red" />
              <span>
                <strong className="font-semibold text-ink">falhas seguidas</strong> conta desde a
                última carga boa, não no total. Um ciclo que falhou muito no passado e roda bem hoje
                não é problema.
              </span>
            </li>
            <li className="flex gap-2">
              <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-ink-4" />
              <span>
                <strong className="font-semibold text-ink">declarado</strong> é ciclo com contrato
                escrito e implementação pendente. Ele não roda por desenho, e por isso não conta
                como atrasado.
              </span>
            </li>
          </ul>
        </Card>
      </CorpoDeConfiguracao>
    </>
  )
}
