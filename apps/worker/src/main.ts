/**
 * Worker de ingestão e consolidação.
 *
 * Processo separado das superfícies web de propósito: um ciclo noturno de
 * reconciliação de 90 dias não pode competir por event loop com a fila que o
 * CSM está usando.
 *
 * Dois modos:
 *   inventario  (padrão)  imprime os ciclos declarados. Não precisa de nada.
 *   worker                sobe agendamento e processamento. Precisa de Redis e
 *                         Postgres.
 */

import pg from 'pg'

import { todosOsCiclos } from './cycle.js'
import './cycles/index.js'
import { criarWorker, registrarAgendas } from './queue.js'
import { registrarDeclaracoes } from './registro.js'
import type { Alarme } from './runner.js'

function inventario(): void {
  const ciclos = todosOsCiclos()
  process.stdout.write(`ciclos declarados: ${ciclos.length}\n`)
  for (const c of ciclos) {
    process.stdout.write(
      `  ${c.id.padEnd(4)} ${c.fase.padEnd(3)} ${c.metodo.padEnd(22)} ` +
        `${(c.agenda ?? 'webhook').padEnd(14)} ${c.descricao}\n`,
    )
  }
}

function urlRedis(): { host: string; port: number; password?: string } {
  const bruta = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'
  const u = new URL(bruta)
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  }
}

async function subirWorker(): Promise<void> {
  const conn = process.env['DATABASE_URL_WORKER'] ?? process.env['DATABASE_URL']
  if (!conn) throw new Error('DATABASE_URL_WORKER não definida.')

  const pool = new pg.Pool({ connectionString: conn, max: 8, application_name: 'ops-worker' })
  const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`)

  // Enquanto não houver canal de plantão configurado, o alarme vai para o log de
  // erro — visível, e nunca engolido em silêncio. É a pendência de
  // observabilidade registrada no PRD, e ela fica explícita aqui.
  const alarmar = async (a: Alarme) => {
    process.stderr.write(
      `${new Date().toISOString()} ALARME[${a.severidade}] ${a.ciclo} · ` +
        `${a.falhasConsecutivas}× · degradação=${a.degradacao} · ${a.mensagem}\n`,
    )
  }

  const deps = { conexao: urlRedis(), pool, alarmar, log }

  // O painel de pipeline lê daqui: ele mostra o que está de fato rodando.
  log(`declarações publicadas: ${await registrarDeclaracoes(pool)}`)

  const fila = await registrarAgendas(deps)
  const worker = criarWorker(deps)

  worker.on('failed', (job, err) => log(`job ${job?.name} falhou: ${err.message}`))
  log(`worker no ar · ${todosOsCiclos().length} ciclos declarados`)

  // Encerramento limpo: ciclo interrompido no meio não pode deixar a trava
  // presa nem o registro de execução aberto para sempre.
  const encerrar = async (sinal: string) => {
    log(`${sinal} recebido, encerrando`)
    await worker.close()
    await fila.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => void encerrar('SIGTERM'))
  process.on('SIGINT', () => void encerrar('SIGINT'))
}

const modo = process.argv[2] ?? 'inventario'
if (modo === 'worker') {
  subirWorker().catch((err: unknown) => {
    process.stderr.write(`falha ao subir o worker: ${String(err)}\n`)
    process.exit(1)
  })
} else {
  inventario()
}
