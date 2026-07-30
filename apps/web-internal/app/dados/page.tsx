import { pool } from '../../lib/db'
import { exigir } from '../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T13 — Painel de pipeline.
 *
 * Objetivo: descobrir que um número está errado ANTES de alguém apresentá-lo
 * numa reunião. Precisa estar em produção antes do primeiro dado real — um
 * pipeline sem painel é um pipeline que se descobre quebrado pelo usuário.
 *
 * A lista de ciclos vem de `ops.cycle_declaration`, publicada pelo worker ao
 * subir: o painel mostra o que está de fato rodando, não o que estava no código
 * com que ele foi empacotado.
 */

interface Ciclo {
  id: string
  descricao: string
  fonte: string
  metodo: string
  agenda: string | null
  fase: string
  implementado: boolean
  em_falha: { degradacao: string; tentativas: number; alarmeApos: number }
  ultimo_sucesso: Date | null
  ultimo_estado: string | null
  duracao_s: number | null
  linhas_gravadas: string | null
  falhas_seguidas: number
}

interface Estado {
  competencia: string | null
  contas: number
  completos: number
  parciais: number
  gerado_em: Date | null
  divergencias: number
  excecoes: number
}

async function carregar(): Promise<{ ciclos: Ciclo[]; estado: Estado }> {
  const db = pool()

  const ciclos = await db.query<Ciclo>(
    `WITH ultima AS (
       SELECT DISTINCT ON (ciclo) ciclo, status, terminado_em, iniciado_em, linhas_gravadas
         FROM ops.cycle_run WHERE status <> 'rodando'
        ORDER BY ciclo, iniciado_em DESC, id DESC
     ),
     sucesso AS (
       SELECT ciclo, max(terminado_em) ultimo FROM ops.cycle_run
        WHERE status = 'ok' GROUP BY ciclo
     ),
     falhas AS (
       -- Falhas CONSECUTIVAS a partir da mais recente: um ciclo que falha uma
       -- vez por semana tem problema diferente de um que falhou três vezes agora.
       SELECT ciclo, count(*) n FROM (
         SELECT ciclo, status,
                row_number() OVER (PARTITION BY ciclo ORDER BY iniciado_em DESC) rn,
                sum(CASE WHEN status <> 'falha' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY ciclo ORDER BY iniciado_em DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) corte
           FROM ops.cycle_run WHERE status <> 'rodando'
       ) t WHERE corte = 0 GROUP BY ciclo
     )
     SELECT d.id, d.descricao, d.fonte, d.metodo, d.agenda, d.fase, d.implementado, d.em_falha,
            s.ultimo AS ultimo_sucesso, u.status AS ultimo_estado,
            EXTRACT(EPOCH FROM (u.terminado_em - u.iniciado_em))::int AS duracao_s,
            u.linhas_gravadas, COALESCE(f.n, 0)::int AS falhas_seguidas
       FROM ops.cycle_declaration d
       LEFT JOIN ultima u ON u.ciclo = d.id
       LEFT JOIN sucesso s ON s.ciclo = d.id
       LEFT JOIN falhas f ON f.ciclo = d.id
      ORDER BY d.id`,
  )

  const estado = await db.query<Estado>(
    `SELECT (SELECT max(competencia)::text FROM metrics.daily_snapshot) competencia,
            (SELECT count(*)::int FROM metrics.daily_snapshot
              WHERE competencia = (SELECT max(competencia) FROM metrics.daily_snapshot)) contas,
            (SELECT count(*)::int FROM metrics.daily_snapshot
              WHERE competencia = (SELECT max(competencia) FROM metrics.daily_snapshot) AND completo) completos,
            (SELECT count(*)::int FROM metrics.daily_snapshot
              WHERE competencia = (SELECT max(competencia) FROM metrics.daily_snapshot) AND NOT completo) parciais,
            (SELECT max(gerado_em) FROM metrics.daily_snapshot
              WHERE competencia = (SELECT max(competencia) FROM metrics.daily_snapshot)) gerado_em,
            (SELECT count(*)::int FROM ops.divergencia WHERE resolvido_em IS NULL) divergencias,
            (SELECT count(*)::int FROM ops.excecao_referencia WHERE estado = 'aberta') excecoes`,
  )

  return { ciclos: ciclos.rows, estado: estado.rows[0] as Estado }
}

function haQuanto(d: Date | null): string {
  if (!d) return 'nunca'
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60_000)
  if (min < 60) return `há ${min} min`
  if (min < 1440) return `há ${Math.round(min / 60)} h`
  return `há ${Math.round(min / 1440)} d`
}

export default async function Painel() {
  // Quem garante o dado é quem opera esta tela.
  await exigir((p) => p.configurar || p.contas === 'base', 'acesso à plataforma de dados')

  const { ciclos, estado } = await carregar()
  const alertas = ciclos.filter((c) => c.falhas_seguidas >= (c.em_falha?.alarmeApos ?? 1))

  return (
    <section>
      <h1>Pipeline de dados</h1>

      {estado.competencia ? (
        <p className="painel__resumo">
          Snapshot de <strong>{estado.competencia}</strong> · {estado.contas} contas ·{' '}
          {estado.parciais > 0 ? (
            <span data-estado="parcial">
              {estado.parciais} parciais, {estado.completos} completas
            </span>
          ) : (
            <span data-estado="ok">todas completas</span>
          )}{' '}
          · publicado {haQuanto(estado.gerado_em)}
        </p>
      ) : (
        // Estado vazio que ensina: diz o que falta, não só que não há nada.
        <p className="painel__resumo" data-estado="parcial">
          Nenhum snapshot consolidado ainda. O primeiro sai depois que os ciclos de
          captação rodarem — ou agora mesmo, contra massa sintética, com <code>make seed</code>.
        </p>
      )}

      {(alertas.length > 0 || estado.divergencias > 0 || estado.excecoes > 0) && (
        <ul className="painel__alertas">
          {alertas.map((c) => (
            <li key={c.id} data-severidade={c.em_falha?.degradacao === 'alarme_critico' ? 'critico' : 'alto'}>
              <strong>{c.id}</strong> falhou {c.falhas_seguidas}× seguidas ·{' '}
              degradação: {c.em_falha?.degradacao}
            </li>
          ))}
          {estado.divergencias > 0 && (
            <li data-severidade="critico">
              {estado.divergencias} divergência(s) da reconciliação sem resolver — é o único
              sinal de que um número já publicado está errado
            </li>
          )}
          {estado.excecoes > 0 && (
            <li data-severidade="alto">
              {estado.excecoes} registro(s) sem conta correspondente na fila de exceção
            </li>
          )}
        </ul>
      )}

      <table className="painel__ciclos">
        <thead>
          <tr>
            <th>Ciclo</th>
            <th>Agenda</th>
            <th>Último sucesso</th>
            <th>Duração</th>
            <th>Linhas</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {ciclos.map((c) => (
            <tr key={c.id}>
              <td>
                <strong>{c.id}</strong> · {c.descricao}
                <small> {c.fonte} · {c.metodo}</small>
              </td>
              <td className="num">{c.agenda ?? 'webhook'}</td>
              <td className="num">{haQuanto(c.ultimo_sucesso)}</td>
              <td className="num">{c.duracao_s !== null ? `${c.duracao_s}s` : '—'}</td>
              <td className="num">{c.linhas_gravadas ?? '—'}</td>
              <td>
                {/* Distinguir "não rodou porque falhou" de "não rodou porque
                    ainda não existe" — são conversas diferentes. */}
                {!c.implementado ? (
                  <span data-estado="pendente">a construir · {c.fase}</span>
                ) : c.falhas_seguidas > 0 ? (
                  <span data-estado="falha">falhando</span>
                ) : c.ultimo_estado === 'ok' ? (
                  <span data-estado="ok">ok</span>
                ) : (
                  <span data-estado="pendente">sem execução</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="painel__nota">
        Esta lista é gerada da declaração dos ciclos publicada pelo worker ao subir —
        ciclo novo aparece aqui sem ninguém mexer nesta tela.
      </p>
    </section>
  )
}
