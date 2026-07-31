import { Aviso, Badge, Card, Kpi, Table, cn } from '@ops/ui'

import { Corpo, Topo } from '../casca'
import { pool } from '../../../lib/db'
import { exigir } from '../../../lib/guarda'

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
  const construidos = ciclos.filter((c) => c.implementado).length

  return (
    <>
      <Topo
        href="/dados"
        acoes={
          <span className="text-[13px] text-ink-2">
            {construidos} de {ciclos.length} ciclos construídos
          </span>
        }
      />
      <Corpo className="grid gap-5">
        {estado.competencia ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              rotulo="Snapshot"
              valor={<span className="text-[22px]">{estado.competencia}</span>}
              nota={`publicado ${haQuanto(estado.gerado_em)}`}
            />
            <Kpi rotulo="Contas" valor={estado.contas} nota={`${estado.completos} completas`} />
            <Kpi
              rotulo="Parciais"
              valor={estado.parciais}
              nota={estado.parciais > 0 ? 'fonte faltando em alguma conta' : 'todas completas'}
              {...(estado.parciais > 0 ? { tom: 'amber' as const } : {})}
            />
            <Kpi
              rotulo="Divergências"
              valor={estado.divergencias}
              /* É o único sinal de que um número JÁ PUBLICADO está errado. */
              nota="reconciliação sem resolver"
              {...(estado.divergencias > 0 ? { tom: 'red' as const } : {})}
            />
          </div>
        ) : (
          // Estado vazio que ensina: diz o que falta, não só que não há nada.
          <Aviso tom="alerta">
            Nenhum snapshot consolidado ainda. O primeiro sai depois que os ciclos de captação
            rodarem — ou agora mesmo, contra massa sintética, com{' '}
            <code className="rounded bg-surface px-1 py-0.5 text-[12px]">make seed</code>.
          </Aviso>
        )}

        {(alertas.length > 0 || estado.divergencias > 0 || estado.excecoes > 0) && (
          <div className="grid gap-2">
            {alertas.map((c) => (
              <Aviso
                key={c.id}
                tom={c.em_falha?.degradacao === 'alarme_critico' ? 'erro' : 'alerta'}
              >
                <strong className="font-semibold">{c.id}</strong> falhou {c.falhas_seguidas}×
                seguidas · degradação: {c.em_falha?.degradacao}
              </Aviso>
            ))}
            {estado.divergencias > 0 && (
              <Aviso tom="erro">
                {estado.divergencias} divergência(s) da reconciliação sem resolver — é o único
                sinal de que um número já publicado está errado
              </Aviso>
            )}
            {estado.excecoes > 0 && (
              <Aviso tom="alerta">
                {estado.excecoes} registro(s) sem conta correspondente na fila de exceção
              </Aviso>
            )}
          </div>
        )}

        <Card title="Ciclos de captação">
          <Table
            cols={['Ciclo', 'Agenda', 'Último sucesso', 'Duração', 'Linhas', 'Estado']}
            /* "sem registros" faria parecer defeito da tela. A declaração é
               publicada pelo worker ao subir: lista vazia significa que o worker
               não subiu, e é isso que a pessoa precisa ler aqui. */
            vazio={
              <>
                Nenhum ciclo declarado. A lista é publicada pelo worker ao subir — se está vazia,
                o worker não subiu contra este banco.
              </>
            }
            rows={ciclos.map((c) => [
              <>
                <span className="font-semibold">{c.id}</span>
                <span className="text-ink-2"> · {c.descricao}</span>
                <span className="mt-0.5 block text-[11.5px] text-ink-3">
                  {c.fonte} · {c.metodo}
                </span>
              </>,
              <span className="tabular-nums text-[12.5px]">{c.agenda ?? 'webhook'}</span>,
              <span className={cn('tabular-nums text-[12.5px]', !c.ultimo_sucesso && 'text-ink-4')}>
                {haQuanto(c.ultimo_sucesso)}
              </span>,
              <span className="tabular-nums text-[12.5px]">
                {c.duracao_s !== null ? `${c.duracao_s}s` : '—'}
              </span>,
              <span className="tabular-nums text-[12.5px]">{c.linhas_gravadas ?? '—'}</span>,
              /* Distinguir "não rodou porque falhou" de "não rodou porque ainda
                 não existe" — são conversas diferentes. */
              !c.implementado ? (
                <Badge>a construir · {c.fase}</Badge>
              ) : c.falhas_seguidas > 0 ? (
                <Badge tone="red">falhando</Badge>
              ) : c.ultimo_estado === 'ok' ? (
                <Badge tone="green">ok</Badge>
              ) : (
                <Badge tone="amber">sem execução</Badge>
              ),
            ])}
          />
        </Card>

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          Esta lista é gerada da declaração dos ciclos publicada pelo worker ao subir — ciclo novo
          aparece aqui sem ninguém mexer nesta tela.
        </p>
      </Corpo>
    </>
  )
}
