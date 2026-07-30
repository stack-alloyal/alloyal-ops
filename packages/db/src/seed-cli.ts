/**
 * `make seed` — popula um banco descartável com massa sintética.
 *
 * Recusa rodar contra banco que tenha conta não criada pelo seed: a diferença
 * entre local e produção é uma variável de ambiente, e semear apaga tudo antes
 * de escrever.
 */
import pg from 'pg'

import { migrate } from './migrate.js'
import { semearComGuarda } from './seed/index.js'

const url = process.env['DATABASE_URL_ADMIN'] ?? process.env['DATABASE_URL']
if (!url) {
  console.error('DATABASE_URL_ADMIN não definida.')
  process.exit(1)
}

const arg = (n: string, padrao: number) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`))
  return v ? Number(v.split('=')[1]) : padrao
}

await migrate(url)
const pool = new pg.Pool({ connectionString: url })
try {
  const r = await semearComGuarda(pool, {
    semente: arg('semente', 42),
    contas: arg('contas', 40),
    dias: arg('dias', 180),
    forcar: process.argv.includes('--forcar'),
  })
  process.stdout.write(
    `massa semeada\n` +
      `  contas ................ ${r.contas}\n` +
      `  dias de histórico ..... ${r.diasDeHistorico}\n` +
      `  linhas de transação ... ${r.linhasTransacao}\n` +
      `  linhas de snapshot .... ${r.linhasSnapshot}\n` +
      `  eventos de MRR ........ ${r.eventosMrr}\n` +
      `  atividades ............ ${r.atividades}\n` +
      `  saídas em curso ....... ${r.cancelamentos}\n`,
  )
} finally {
  await pool.end()
}
