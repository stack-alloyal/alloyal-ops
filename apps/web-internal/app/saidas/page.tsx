import {
  faltaParaEncerrar,
  listarSaidas,
  resumoChurn,
  rotuloDoMotivo,
  type Saida,
} from '@ops/success'
import { Vazio } from '@ops/ui'

import { acaoConfirmarAviso, acaoConfirmarCobranca, acaoEncerrar, acaoReter } from './acoes'
import { pool } from '../../lib/db'
import { exigir, temEscopo } from '../../lib/guarda'

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

const ESTADO: Record<string, { rotulo: string; estado: string }> = {
  anunciado: { rotulo: 'Anunciado', estado: 'falha' },
  em_aviso: { rotulo: 'Em aviso', estado: 'parcial' },
  retido: { rotulo: 'Retido', estado: 'ok' },
  encerrado: { rotulo: 'Encerrado', estado: 'pendente' },
}

const MES = (c: string | null) => (c === null ? '—' : c)

function janela(s: Saida): { texto: string; estado: string } {
  if (s.estado === 'retido') return { texto: 'revertida', estado: 'ok' }
  if (s.estado === 'encerrado') return { texto: 'encerrada', estado: 'pendente' }
  if (s.dataFimAviso === null) {
    return { texto: 'aviso prévio não confirmado', estado: 'falha' }
  }
  const d = s.diasParaFimDoAviso ?? 0
  if (d < 0) return { texto: `janela fechou há ${-d} d`, estado: 'pendente' }
  if (d === 0) return { texto: 'fecha hoje', estado: 'falha' }
  return { texto: `${d} d para reverter`, estado: d <= 15 ? 'falha' : 'parcial' }
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
    <ol className="saida__datas">
      {passos.map((p) => (
        <li key={p.rotulo} data-feito={p.feito ? 'sim' : 'nao'}>
          <span className="saida__passo">{p.rotulo}</span>
          <strong>{p.valor}</strong>
          {p.nota && <small>{p.nota}</small>}
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
    <li className="saida" data-estado={s.estado}>
      <div className="saida__cabeca">
        <strong>{s.conta}</strong>
        <span className="fila__tag" data-estado={e.estado}>
          {e.rotulo}
        </span>
        <span className="saida__mrr">{REAIS(s.mrrCentavosNaLevantada)}/mês</span>
        {s.origem === 'alloyal' && <span className="fila__tag">encerramento pela Alloyal</span>}
        {s.motivo && <span className="fila__tag">{rotuloDoMotivo(s.motivo)}</span>}
        <span className="saida__janela" data-estado={j.estado}>
          {j.texto}
        </span>
      </div>

      <Datas s={s} />

      {aberta && (
        <div className="saida__acoes">
          {!s.avisoConfirmadoPor && (
            <form action={acaoConfirmarAviso}>
              <input type="hidden" name="id" value={s.id} />
              <label>
                Aviso prévio
                <input
                  name="avisoPrevioDias"
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={s.avisoPrevioDias ?? 30}
                  required
                />
                dias
              </label>
              {/* O contrato diz N, mas há acordo, renúncia e prorrogação — e é o
                  campo que mais desloca receita entre meses. */}
              <button>Confirmar aviso</button>
            </form>
          )}

          {!s.cobrancaConfirmadaPor && (
            <form action={acaoConfirmarCobranca}>
              <input type="hidden" name="id" value={s.id} />
              <label>
                Última cobrança
                <input name="competencia" type="month" required />
              </label>
              <button>Confirmar cobrança (Financeiro)</button>
            </form>
          )}

          <form action={acaoReter}>
            <input type="hidden" name="id" value={s.id} />
            <input name="nota" type="text" placeholder="O que reverteu? (opcional)" maxLength={500} />
            <button>Registrar retenção</button>
          </form>

          {falta.length === 1 && falta[0]?.startsWith('aprovação') ? (
            podeAprovar ? (
              <form action={acaoEncerrar}>
                <input type="hidden" name="id" value={s.id} />
                <button data-perigo="sim">Aprovar e encerrar</button>
                <small>Grava o churn de receita em {MES(s.competenciaEfeitoReceita)}.</small>
              </form>
            ) : (
              <p className="saida__falta">
                Pronta para encerrar — falta a aprovação de quem tem alçada de distrato.
              </p>
            )
          ) : (
            <p className="saida__falta">Para encerrar, falta: {falta.join('; ')}</p>
          )}
        </div>
      )}

      {s.estado === 'retido' && s.retidoPor && (
        <p className="saida__falta">
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
    <section className="saidas">
      <h1>Saídas</h1>

      {q.erro && (
        <p className="conta__aviso" data-estado="falha" role="alert">
          {q.erro}
        </p>
      )}
      {q.ok && (
        <p className="conta__aviso" data-estado="ok" role="status">
          {q.ok}
        </p>
      )}

      {resumo && (
        <>
          {/* Os dois churns lado a lado. Ver juntos é o ponto: o mês em que as
              contas saem quase nunca é o mês em que a receita sai. */}
          <div className="conta__numeros">
            <div className="conta__numero">
              <span className="conta__rotulo">Churn de contas · {resumo.competencia}</span>
              <strong>{resumo.contasQueLevantaram}</strong>
              <small>
                {REAIS(resumo.mrrQueLevantouCentavos)} levantaram a mão
                {resumo.retidasDepois > 0 && ` · ${resumo.retidasDepois} revertida(s) depois`}
              </small>
            </div>
            <div className="conta__numero">
              <span className="conta__rotulo">Churn de receita · {resumo.competencia}</span>
              <strong>{REAIS(resumo.mrrRealizadoCentavos)}</strong>
              <small>{resumo.contasComEfeito} conta(s) saíram do faturamento</small>
            </div>
            <div className="conta__numero">
              <span className="conta__rotulo">Saída comprometida</span>
              <strong data-estado={Number(resumo.mrrComprometidoCentavos) > 0 ? 'parcial' : 'ok'}>
                {REAIS(resumo.mrrComprometidoCentavos)}
              </strong>
              {/* O número que responde "quanto do faturamento de hoje já está
                  perdido" — receita que ainda entra de cliente já perdido. */}
              <small>
                {resumo.contasComprometidas} conta(s) já perdidas ainda faturando
              </small>
            </div>
            <div className="conta__numero">
              <span className="conta__rotulo">Retido no mês</span>
              <strong data-estado={resumo.retidasNaCompetencia > 0 ? 'ok' : undefined}>
                {REAIS(resumo.mrrRetidoCentavos)}
              </strong>
              <small>{resumo.retidasNaCompetencia} saída(s) revertida(s)</small>
            </div>
          </div>
          <p className="fila__nota">
            Contas e receita não fecham no mesmo mês, e a diferença é de propósito: um
            cliente que levanta a mão hoje entra no churn de contas hoje, mas continua
            faturando durante todo o aviso prévio. Reconhecer a perda no dia do anúncio
            subestima o trimestre; contar o cliente como ativo até a última fatura esconde
            uma perda que já aconteceu — e que ainda dava para reverter.
          </p>
        </>
      )}

      <h2>Em andamento ({abertas.length})</h2>
      {abertas.length === 0 ? (
        <Vazio
          titulo="Nenhuma saída em andamento."
          porque="Saídas aparecem aqui quando alguém registra uma levantada de mão, ou quando o Financeiro inicia um encerramento por inadimplência. Lista vazia é boa notícia, não erro de carregamento."
          acao={{ texto: 'Ver a fila de trabalho', href: '/' }}
        />
      ) : (
        <ul className="saidas__lista">
          {abertas.map((s) => (
            <Linha key={s.id} s={s} podeAprovar={podeAprovar} />
          ))}
        </ul>
      )}

      {fechadas.length > 0 && (
        <details className="fila__backlog">
          <summary>{fechadas.length} encerradas ou revertidas</summary>
          <ul className="saidas__lista" data-atenuado="sim">
            {fechadas.map((s) => (
              <Linha key={s.id} s={s} podeAprovar={false} />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
