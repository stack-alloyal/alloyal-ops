/**
 * Agendamento e processamento dos ciclos (BullMQ + Redis).
 *
 * Esta camada é deliberadamente fina. Ela decide QUANDO um ciclo roda; toda a
 * semântica de COMO ele roda — tentativas, backoff, watermark, alarme, trava —
 * vive no executor, porque é lá que ela é testável contra Postgres real.
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import type pg from 'pg'

import type { Ciclo } from './cycle.js'
import { todosOsCiclos } from './cycle.js'
import { ehCasca } from './registro.js'
import { executarCiclo, type Alarme, type DepsRunner } from './runner.js'

export const FILA = 'ops-ciclos'

/**
 * Fuso do agendamento.
 *
 * As agendas são declaradas em horário de São Paulo, não em UTC, e a conversão
 * fica com o agendador. Cron em UTC com um comentário dizendo o horário local é
 * a forma clássica de o comentário e o valor divergirem — e o sintoma aparece
 * como "o snapshot saiu na hora errada", meses depois.
 */
export const FUSO_AGENDA = 'America/Sao_Paulo'

export interface DepsFila {
  readonly conexao: ConnectionOptions
  readonly pool: pg.Pool
  readonly alarmar: (a: Alarme) => Promise<void>
  readonly log?: (msg: string) => void
}

/**
 * Quais ciclos entram na agenda.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CASCA NÃO SE AGENDA, e isto é correção de um defeito observado.             │
 * │                                                                            │
 * │ Antes, todo ciclo com `agenda` entrava — inclusive os declarados sem        │
 * │ implementação. Eles lançam por desenho, então C1 e C5 falhavam a cada 15    │
 * │ minutos: 96 falhas por dia cada, alarme disparado por algo que ninguém      │
 * │ escreveu ainda, e o histórico da tela de Sincronização com 90% de ruído     │
 * │ soterrando falha de verdade.                                               │
 * │                                                                            │
 * │ A detecção é a MESMA de `registrarDeclaracoes` (`ehCasca`), e é de           │
 * │ propósito: duas regras para "este ciclo está implementado?" divergem, e a   │
 * │ divergência apareceria como um ciclo marcado implementado na tela e não     │
 * │ agendado no Redis.                                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
async function agendaveis(): Promise<readonly Ciclo[]> {
  // Ciclo de webhook não tem agenda: ele é acordado pela fonte.
  const comAgenda = todosOsCiclos().filter((c) => c.agenda !== null)
  const saida: Ciclo[] = []
  for (const c of comAgenda) {
    if (!(await ehCasca(c))) saida.push(c)
  }
  return saida
}

/**
 * Registra (ou atualiza) a agenda de cada ciclo declarado.
 *
 * Idempotente: rodar de novo com a mesma declaração não duplica agendamento, e
 * mudar o cron no código muda o agendamento no próximo start. A declaração no
 * código é a fonte — não o que está gravado no Redis.
 */
export async function registrarAgendas(deps: DepsFila): Promise<Queue> {
  const log = deps.log ?? (() => undefined)
  const fila = new Queue(FILA, { connection: deps.conexao })

  const declarados = new Set<string>()
  for (const c of await agendaveis()) {
    declarados.add(c.id)
    await fila.upsertJobScheduler(
      c.id,
      { pattern: c.agenda as string, tz: FUSO_AGENDA },
      { name: c.id, data: { ciclo: c.id } },
    )
    log(`agendado ${c.id} · ${c.agenda} (${FUSO_AGENDA})`)
  }

  // Ciclo removido do código precisa sair do Redis: senão ele continua
  // disparando um job que não tem mais processador, e o sintoma é uma fila que
  // cresce sem ninguém entender por quê.
  for (const s of await fila.getJobSchedulers()) {
    if (s.key && !declarados.has(s.key)) {
      await fila.removeJobScheduler(s.key)
      log(`agenda órfã removida: ${s.key}`)
    }
  }

  return fila
}

/**
 * Sobe o processador.
 *
 * `attempts: 1` de propósito: quem repete é o executor, conforme a política
 * declarada no ciclo. Deixar as duas camadas repetindo multiplicaria as
 * tentativas — um ciclo com 3 tentativas viraria 9 — e o número real de
 * chamadas à origem deixaria de ser o que o contrato diz.
 */
export function criarWorker(deps: DepsFila): Worker {
  const log = deps.log ?? (() => undefined)
  const porId = new Map(todosOsCiclos().map((c) => [c.id, c]))

  const runner: DepsRunner = {
    pool: deps.pool,
    agora: () => new Date(),
    alarmar: deps.alarmar,
    log,
  }

  return new Worker(
    FILA,
    async (job) => {
      const id = String(job.data?.ciclo ?? job.name)
      const ciclo = porId.get(id)
      if (!ciclo) {
        // Não é erro de execução: é agenda apontando para ciclo que não existe
        // mais. Falhar aqui encheria a fila de jobs mortos.
        log(`job para ciclo desconhecido: ${id}`)
        return { estado: 'desconhecido', ciclo: id }
      }
      return executarCiclo(ciclo, runner)
    },
    {
      connection: deps.conexao,
      // Um ciclo por vez por processo: os ciclos noturnos são pesados e
      // competir entre si só aumenta o tempo total da janela.
      concurrency: 1,
    },
  )
}

/** Dispara um ciclo fora da agenda — usado pelo painel de pipeline e pela CLI. */
export async function dispararAgora(fila: Queue, cicloId: string): Promise<void> {
  await fila.add(cicloId, { ciclo: cicloId }, { attempts: 1, removeOnComplete: 100 })
}
