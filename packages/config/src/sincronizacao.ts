/**
 * O que a tela de Sincronização lê: os ciclos declarados, a última execução de
 * cada um e o histórico.
 *
 * Nada aqui é tabela nova. `ops.cycle_declaration` é escrita pelo worker na partida
 * (`registrarDeclaracoes`) e `ops.cycle_run` pelo executor a cada rodada — a tela
 * só junta as duas. Criar tabela própria de painel faria o painel poder divergir do
 * que de fato roda, que é o pior defeito possível num painel de pipeline.
 */

import type pg from 'pg'

export interface CicloNaTela {
  readonly id: string
  readonly descricao: string
  readonly fonte: string
  readonly metodo: string
  readonly agenda: string | null
  readonly fase: string
  readonly implementado: boolean
  /** Última execução, de qualquer status. */
  readonly ultimaEm: Date | null
  readonly ultimoStatus: string | null
  readonly ultimoErro: string | null
  readonly linhasLidas: number | null
  readonly linhasGravadas: number | null
  readonly duracaoSegundos: number | null
  /** Última execução BEM-SUCEDIDA. Diferente da última quando a atual falhou. */
  readonly ultimoSucessoEm: Date | null
  readonly falhasSeguidas: number
}

/**
 * Os ciclos, com o estado de cada um.
 *
 * `LEFT JOIN LATERAL` e não agregação: precisa-se da LINHA da última execução (com
 * erro, contagens e duração), não de um máximo. Com `max(iniciado_em)` e depois um
 * segundo passo, duas execuções no mesmo instante devolveriam campos de linhas
 * diferentes — e o painel mostraria o erro de uma com as contagens da outra.
 */
export async function ciclosNaTela(db: pg.Pool): Promise<CicloNaTela[]> {
  const { rows } = await db.query<{
    id: string
    descricao: string
    fonte: string
    metodo: string
    agenda: string | null
    fase: string
    implementado: boolean
    ultima_em: Date | null
    ultimo_status: string | null
    ultimo_erro: string | null
    linhas_lidas: string | null
    linhas_gravadas: string | null
    duracao: string | null
    ultimo_sucesso_em: Date | null
    falhas_seguidas: string
  }>(
    `SELECT d.id, d.descricao, d.fonte, d.metodo, d.agenda, d.fase, d.implementado,
            u.iniciado_em                                   AS ultima_em,
            u.status                                        AS ultimo_status,
            u.erro                                          AS ultimo_erro,
            u.linhas_lidas::text                            AS linhas_lidas,
            u.linhas_gravadas::text                         AS linhas_gravadas,
            extract(epoch FROM (u.terminado_em - u.iniciado_em))::text AS duracao,
            s.iniciado_em                                   AS ultimo_sucesso_em,
            coalesce(f.n, 0)::text                          AS falhas_seguidas
       FROM ops.cycle_declaration d
       LEFT JOIN LATERAL (
         SELECT * FROM ops.cycle_run r
          WHERE r.ciclo = d.id ORDER BY r.iniciado_em DESC LIMIT 1
       ) u ON true
       LEFT JOIN LATERAL (
         SELECT r.iniciado_em FROM ops.cycle_run r
          WHERE r.ciclo = d.id AND r.status = 'ok' ORDER BY r.iniciado_em DESC LIMIT 1
       ) s ON true
       LEFT JOIN LATERAL (
         -- Falhas SEGUIDAS: conta desde a última execução com sucesso. É o número
         -- que decide alarme, e é diferente de "falhas no total" — um ciclo que
         -- falhou 40 vezes no ano passado e roda bem hoje não é problema.
         SELECT count(*) AS n FROM ops.cycle_run r
          WHERE r.ciclo = d.id AND r.status = 'falha'
            AND r.iniciado_em > coalesce(s.iniciado_em, '-infinity'::timestamptz)
       ) f ON true
      ORDER BY d.fase, d.id`,
  )

  return rows.map((r) => ({
    id: r.id,
    descricao: r.descricao,
    fonte: r.fonte,
    metodo: r.metodo,
    agenda: r.agenda,
    fase: r.fase,
    implementado: r.implementado,
    ultimaEm: r.ultima_em,
    ultimoStatus: r.ultimo_status,
    ultimoErro: r.ultimo_erro,
    linhasLidas: r.linhas_lidas === null ? null : Number(r.linhas_lidas),
    linhasGravadas: r.linhas_gravadas === null ? null : Number(r.linhas_gravadas),
    duracaoSegundos: r.duracao === null ? null : Math.round(Number(r.duracao)),
    ultimoSucessoEm: r.ultimo_sucesso_em,
    falhasSeguidas: Number(r.falhas_seguidas),
  }))
}

export interface ExecucaoNaTela {
  readonly id: string
  readonly ciclo: string
  readonly iniciadoEm: Date
  readonly terminadoEm: Date | null
  readonly status: string
  readonly linhasLidas: number | null
  readonly linhasGravadas: number | null
  readonly erro: string | null
  readonly detalhe: Record<string, unknown> | null
}

export async function historicoDeExecucoes(
  db: pg.Pool,
  filtro: { ciclo?: string; limite?: number } = {},
): Promise<ExecucaoNaTela[]> {
  const limite = Math.min(Math.max(filtro.limite ?? 60, 1), 300)
  const { rows } = await db.query<{
    id: string
    ciclo: string
    iniciado_em: Date
    terminado_em: Date | null
    status: string
    linhas_lidas: string | null
    linhas_gravadas: string | null
    erro: string | null
    detalhe: Record<string, unknown> | null
  }>(
    `SELECT id::text, ciclo, iniciado_em, terminado_em, status,
            linhas_lidas::text, linhas_gravadas::text, erro, detalhe
       FROM ops.cycle_run
      WHERE ($1::text IS NULL OR ciclo = $1)
      ORDER BY iniciado_em DESC, id DESC
      LIMIT $2`,
    [filtro.ciclo ?? null, limite],
  )
  return rows.map((r) => ({
    id: r.id,
    ciclo: r.ciclo,
    iniciadoEm: r.iniciado_em,
    terminadoEm: r.terminado_em,
    status: r.status,
    linhasLidas: r.linhas_lidas === null ? null : Number(r.linhas_lidas),
    linhasGravadas: r.linhas_gravadas === null ? null : Number(r.linhas_gravadas),
    erro: r.erro,
    detalhe: r.detalhe,
  }))
}

/**
 * Converte a agenda cron em frase.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Pura, exportada e testada, porque cron lido de cabeça é lido errado. `0 2 * │
 * │ * *` é "todo dia às 02:00" e "a cada 15 minutos" (barra-15 nos minutos) — e a     │
 * │ diferença entre os dois é a diferença entre uma carga por dia e 96.         │
 * │                                                                            │
 * │ Cobre só as formas que os ciclos daqui usam. Qualquer outra volta como o    │
 * │ próprio cron, em vez de uma frase inventada — dizer "a cada hora" para um   │
 * │ cron que roda a cada minuto é pior que não traduzir.                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function agendaEmPalavras(cron: string | null): string {
  if (cron === null || cron.trim() === '') return 'sem agenda — só sob demanda'
  const p = cron.trim().split(/\s+/)
  if (p.length !== 5) return cron

  const [min, hora, dia, mes, semana] = p as [string, string, string, string, string]
  const todoDia = dia === '*' && mes === '*' && semana === '*'

  const cadaN = /^\*\/(\d+)$/
  if (cadaN.test(min) && hora === '*' && todoDia) {
    return `a cada ${min.match(cadaN)![1]} minutos`
  }
  if (min === '*' && hora === '*' && todoDia) return 'a cada minuto'
  if (/^\d+$/.test(min) && hora === '*' && todoDia) return 'a cada hora'
  if (/^\d+$/.test(min) && /^\d+$/.test(hora) && todoDia) {
    return `todo dia às ${hora.padStart(2, '0')}:${min.padStart(2, '0')}`
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hora) && dia === '1' && mes === '*') {
    return `dia 1 de cada mês às ${hora.padStart(2, '0')}:${min.padStart(2, '0')}`
  }
  return cron
}

/** Quando um ciclo com agenda diária deveria ter rodado por último. */
export function atrasado(c: CicloNaTela, agora: Date): boolean {
  if (!c.implementado || c.agenda === null) return false
  // Só para agenda diária: para agenda de minutos o atraso é medido em minutos e não vale a
  // pena estimar aqui — o alarme do executor já cobre.
  const m = c.agenda.trim().match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/)
  if (!m) return false
  if (c.ultimoSucessoEm === null) return true
  // Mais de 26h sem sucesso numa agenda diária: é o mesmo prazo que
  // `consolidacao.ts` usa para a réplica, e a folga de 2h absorve atraso normal.
  return agora.getTime() - c.ultimoSucessoEm.getTime() > 26 * 3_600_000
}
