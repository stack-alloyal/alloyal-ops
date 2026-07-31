import {
  faltaParaEncerrar,
  listarSaidas,
  resumoChurn,
  rotuloDoMotivo,
  type Saida,
} from '@ops/success'
import { Aviso, Badge, Btn, Card, Field, Kpi, Vazio, cn } from '@ops/ui'
import { Check } from 'lucide-react'

import { acaoConfirmarAviso, acaoConfirmarCobranca, acaoEncerrar, acaoReter } from './acoes'
import { Corpo, Topo } from '../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * Saídas — o churn real, com as quatro datas visíveis.
 *
 * A tela existe porque churn de contas e churn de receita não fecham no mesmo
 * mês, e a diferença entre os dois é dinheiro que ainda está entrando de um
 * cliente que já foi perdido. Um número só esconde isso nas duas direções.
 *
 * O que é AÇÃO aqui é a janela de retenção: enquanto ela está aberta a saída
 * ainda pode ser revertida, e é a única parte da tela em que o tempo corre
 * contra. O resto é registro.
 */

const REAIS = (c: string | null) =>
  c === null
    ? '—'
    : (Number(c) / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      })

const ESTADO: Record<string, { rotulo: string; tom: 'red' | 'amber' | 'green' | 'slate' }> = {
  anunciado: { rotulo: 'Anunciado', tom: 'red' },
  em_aviso: { rotulo: 'Em aviso', tom: 'amber' },
  retido: { rotulo: 'Retido', tom: 'green' },
  encerrado: { rotulo: 'Encerrado', tom: 'slate' },
}

const MES = (c: string | null) => c ?? '—'

function janela(s: Saida): { texto: string; cor: string } {
  if (s.estado === 'retido') return { texto: 'revertida', cor: 'text-green' }
  if (s.estado === 'encerrado') return { texto: 'encerrada', cor: 'text-ink-3' }
  if (s.dataFimAviso === null) {
    return { texto: 'aviso prévio não confirmado', cor: 'text-red' }
  }
  const d = s.diasParaFimDoAviso ?? 0
  if (d < 0) return { texto: `janela fechou há ${-d} d`, cor: 'text-ink-3' }
  if (d === 0) return { texto: 'fecha hoje', cor: 'text-red' }
  return { texto: `${d} d para reverter`, cor: d <= 15 ? 'text-red' : 'text-amber-700' }
}

/** A linha do tempo das quatro datas, com quem confirmou cada uma. */
function Datas({ s }: { s: Saida }) {
  // Numa saída revertida os dois últimos passos não estão PENDENTES, estão
  // dispensados: a receita nunca saiu, e nunca haverá última cobrança. Dizer
  // "aguarda o Financeiro" ali inventa uma tarefa que ninguém deve fazer — e
  // alguém a faria, porque a tela pediu.
  const revertida = s.estado === 'retido'
  const passos = [
    {
      rotulo: '1 · Levantada',
      valor: s.dataLevantada ?? (s.origem === 'alloyal' ? 'provisão' : '—'),
      nota: [s.canal, s.quemComunicou].filter(Boolean).join(' · ') || null,
      feito: s.dataLevantada !== null || s.origem === 'alloyal',
    },
    {
      rotulo: '2 · Fim do aviso',
      valor: s.dataFimAviso ?? '—',
      nota: s.avisoConfirmadoPor
        ? `${s.avisoPrevioDias} d · confirmado por ${s.avisoConfirmadoPor}`
        : 'aguarda confirmação de CS ou Jurídico',
      feito: s.avisoConfirmadoPor !== null,
    },
    {
      rotulo: '3 · Última cobrança',
      valor: MES(s.competenciaUltimaCobranca),
      nota: s.cobrancaConfirmadaPor
        ? `confirmado por ${s.cobrancaConfirmadaPor}`
        : revertida
          ? 'não se aplica — a saída foi revertida'
          : 'aguarda confirmação do Financeiro',
      feito: s.cobrancaConfirmadaPor !== null || revertida,
    },
    {
      rotulo: '4 · Efeito na receita',
      valor: MES(s.competenciaEfeitoReceita),
      // Derivada, nunca digitada — senão um dia o churn de receita e a última
      // cobrança discordam, e a diferença vira ajuste sem explicação.
      nota: s.competenciaEfeitoReceita
        ? 'derivada da última cobrança + 1'
        : revertida
          ? 'a receita nunca saiu'
          : 'depende das duas confirmações',
      feito: s.competenciaEfeitoReceita !== null || revertida,
    },
  ]
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {passos.map((p) => (
        <li
          key={p.rotulo}
          className={cn(
            'rounded-md border bg-surface-2 px-3 py-2',
            p.feito ? 'border-line' : 'border-dashed border-line-strong opacity-80',
          )}
        >
          <span className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
            {p.feito && <Check className="h-3 w-3 text-green" />}
            {p.rotulo}
          </span>
          <strong className="mt-0.5 block tabular-nums text-[14px] font-bold text-ink">
            {p.valor}
          </strong>
          {p.nota && <span className="mt-0.5 block text-[11.5px] text-ink-3">{p.nota}</span>}
        </li>
      ))}
    </ol>
  )
}

function Linha({ s, podeAprovar }: { s: Saida; podeAprovar: boolean }) {
  const e = ESTADO[s.estado]!
  const j = janela(s)
  const aberta = s.estado === 'anunciado' || s.estado === 'em_aviso'
  const falta = faltaParaEncerrar(s)

  return (
    <li
      className={cn(
        'rounded-lg border border-line border-l-[3px] bg-surface p-[14px] shadow-sm',
        s.estado === 'anunciado' && 'border-l-red',
        s.estado === 'em_aviso' && 'border-l-amber',
        s.estado === 'retido' && 'border-l-green',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <strong className="text-[14px] font-bold tracking-[-0.01em] text-ink">{s.conta}</strong>
        <Badge tone={e.tom}>{e.rotulo}</Badge>
        <span className="tabular-nums text-[12.5px] text-ink-3">
          {REAIS(s.mrrCentavosNaLevantada)}/mês
        </span>
        {s.origem === 'alloyal' && <Badge>encerramento pela Alloyal</Badge>}
        {s.motivo && <Badge tone="indigo">{rotuloDoMotivo(s.motivo)}</Badge>}
        <span className={cn('ml-auto text-[12.5px] font-semibold', j.cor)}>{j.texto}</span>
      </div>

      <div className="mt-3">
        <Datas s={s} />
      </div>

      {aberta && (
        <div className="mt-3 grid gap-2 border-t border-line pt-3">
          {!s.avisoConfirmadoPor && (
            <form action={acaoConfirmarAviso} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={s.id} />
              <Field
                label="Aviso prévio (dias)"
                name="avisoPrevioDias"
                type="number"
                min={0}
                max={365}
                defaultValue={s.avisoPrevioDias ?? 30}
                required
                className="w-24"
              />
              {/* O contrato diz N, mas há acordo, renúncia e prorrogação — e é o
                  campo que mais desloca receita entre meses. */}
              <Btn type="submit" variant="ghost">
                Confirmar aviso
              </Btn>
            </form>
          )}

          {!s.cobrancaConfirmadaPor && (
            <form action={acaoConfirmarCobranca} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={s.id} />
              <Field
                label="Última cobrança"
                name="competencia"
                type="month"
                required
                className="w-40"
              />
              <Btn type="submit" variant="ghost">
                Confirmar cobrança (Financeiro)
              </Btn>
            </form>
          )}

          <form action={acaoReter} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={s.id} />
            <div className="min-w-[16em] flex-1">
              <Field
                label="Retenção"
                name="nota"
                type="text"
                placeholder="O que reverteu? (opcional)"
                maxLength={500}
              />
            </div>
            <Btn type="submit" variant="ghost">
              Registrar retenção
            </Btn>
          </form>

          {falta.length === 1 && falta[0]?.startsWith('aprovação') ? (
            podeAprovar ? (
              <form action={acaoEncerrar} className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="id" value={s.id} />
                {/* Encerrar grava no ledger e não se desfaz: o botão diz isso. */}
                <Btn type="submit" variant="danger">
                  Aprovar e encerrar
                </Btn>
                <span className="text-[12.5px] text-ink-3">
                  Grava o churn de receita em {MES(s.competenciaEfeitoReceita)}.
                </span>
              </form>
            ) : (
              <p className="text-[12.5px] text-ink-3">
                Pronta para encerrar — falta a aprovação de quem tem alçada de distrato.
              </p>
            )
          ) : (
            <p className="text-[12.5px] text-ink-3">Para encerrar, falta: {falta.join('; ')}</p>
          )}
        </div>
      )}

      {s.estado === 'retido' && s.retidoPor && (
        <p className="mt-2 text-[12.5px] text-ink-3">
          Revertida em {s.retidoEm} por {s.retidoPor} — a receita nunca saiu.
        </p>
      )}
    </li>
  )
}

export default async function Saidas({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; competencia?: string }>
}) {
  const id = await exigir((p) => temEscopo(p.contas), 'saídas e churn')
  const q = await searchParams

  const hoje = new Date().toISOString().slice(0, 10)
  const comp = q.competencia ? `${q.competencia}-01` : `${hoje.slice(0, 7)}-01`

  const [saidas, resumo] = await Promise.all([
    listarSaidas(pool(), id),
    // O resumo lê a base inteira: é número de receita, e receita não tem
    // carteira. Quem não pode ver receita não chega a esta linha.
    id.permissoes.receita !== 'nenhum' || id.permissoes.configurar
      ? resumoChurn(pool(), comp)
      : null,
  ])

  const abertas = saidas.filter((s) => s.estado === 'anunciado' || s.estado === 'em_aviso')
  const fechadas = saidas.filter((s) => s.estado === 'retido' || s.estado === 'encerrado')
  const podeAprovar = id.permissoes.aprovaDistrato !== 'nao' || id.permissoes.configurar

  return (
    <>
      <Topo href="/saidas" />
      <Corpo className="grid gap-5">
        {q.erro && <Aviso tom="erro" papel="alert">{q.erro}</Aviso>}
        {q.ok && <Aviso tom="ok" papel="status">{q.ok}</Aviso>}

        {resumo && (
          <>
            {/* Os dois churns lado a lado. Ver juntos é o ponto: o mês em que as
                contas saem quase nunca é o mês em que a receita sai. */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                rotulo={`Churn de contas · ${resumo.competencia}`}
                valor={resumo.contasQueLevantaram}
                nota={
                  <>
                    {REAIS(resumo.mrrQueLevantouCentavos)} levantaram a mão
                    {resumo.retidasDepois > 0 && ` · ${resumo.retidasDepois} revertida(s) depois`}
                  </>
                }
              />
              <Kpi
                rotulo={`Churn de receita · ${resumo.competencia}`}
                valor={REAIS(resumo.mrrRealizadoCentavos)}
                nota={`${resumo.contasComEfeito} conta(s) saíram do faturamento`}
              />
              <Kpi
                rotulo="Saída comprometida"
                valor={REAIS(resumo.mrrComprometidoCentavos)}
                /* O número que responde "quanto do faturamento de hoje já está
                   perdido" — receita que ainda entra de cliente já perdido. */
                nota={`${resumo.contasComprometidas} conta(s) já perdidas ainda faturando`}
                {...(Number(resumo.mrrComprometidoCentavos) > 0 ? { tom: 'amber' as const } : {})}
              />
              <Kpi
                rotulo="Retido no mês"
                valor={REAIS(resumo.mrrRetidoCentavos)}
                nota={`${resumo.retidasNaCompetencia} saída(s) revertida(s)`}
                {...(resumo.retidasNaCompetencia > 0 ? { tom: 'green' as const } : {})}
              />
            </div>
            <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
              Contas e receita não fecham no mesmo mês, e a diferença é de propósito: um cliente
              que levanta a mão hoje entra no churn de contas hoje, mas continua faturando durante
              todo o aviso prévio. Reconhecer a perda no dia do anúncio subestima o trimestre;
              contar o cliente como ativo até a última fatura esconde uma perda que já aconteceu —
              e que ainda dava para reverter.
            </p>
          </>
        )}

        <Card title={`Em andamento (${abertas.length})`}>
          {abertas.length === 0 ? (
            <Vazio
              titulo="Nenhuma saída em andamento."
              porque="Saídas aparecem aqui quando alguém registra uma levantada de mão, ou quando o Financeiro inicia um encerramento por inadimplência. Lista vazia é boa notícia, não erro de carregamento."
              acao={{ texto: 'Ver a fila de trabalho', href: '/' }}
              className="border-0 p-0"
            />
          ) : (
            <ul className="grid gap-3">
              {abertas.map((s) => (
                <Linha key={s.id} s={s} podeAprovar={podeAprovar} />
              ))}
            </ul>
          )}
        </Card>

        {fechadas.length > 0 && (
          <details>
            <summary className="cursor-pointer select-none text-[13px] font-semibold text-ink-2 hover:text-ink">
              {fechadas.length} encerradas ou revertidas
            </summary>
            <ul className="mt-3 grid gap-3 opacity-75">
              {fechadas.map((s) => (
                <Linha key={s.id} s={s} podeAprovar={false} />
              ))}
            </ul>
          </details>
        )}
      </Corpo>
    </>
  )
}
