/**
 * Executor de migrations.
 *
 * Doc 00, seção 11: migrations versionadas e reversíveis, aplicadas e revertidas
 * em banco limpo como portão de CI.
 *
 * Deliberadamente sem framework de migration. O conteúdo é SQL puro e revisável
 * — as decisões de isolamento (0005) precisam ser legíveis por quem audita
 * segurança, não escondidas atrás de um DSL.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

interface Migration {
  readonly nome: string
  readonly sql: string
  readonly hash: string
}

function carregar(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((nome) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, nome), 'utf8')
      return { nome, sql, hash: createHash('sha256').update(sql).digest('hex').slice(0, 16) }
    })
}

export async function migrate(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString })
  await client.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migration (
        nome        text PRIMARY KEY,
        hash        text NOT NULL,
        aplicada_em timestamptz NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query<{ nome: string; hash: string }>(
      'SELECT nome, hash FROM public.schema_migration',
    )
    const aplicadas = new Map(rows.map((r) => [r.nome, r.hash]))

    for (const m of carregar()) {
      const jaAplicada = aplicadas.get(m.nome)

      if (jaAplicada !== undefined) {
        // Migration aplicada que mudou de conteúdo é erro, não aviso: significa
        // que produção e repositório divergiram, e a divergência é invisível.
        if (jaAplicada !== m.hash) {
          throw new Error(
            `Migration ${m.nome} já aplicada com conteúdo diferente ` +
              `(banco: ${jaAplicada}, repo: ${m.hash}). Crie uma migration nova.`,
          )
        }
        continue
      }

      process.stdout.write(`  → ${m.nome} ... `)
      // Cada arquivo abre e fecha a própria transação (BEGIN/COMMIT no SQL),
      // para que uma migration possa conter comandos que não rodam em bloco.
      await client.query(m.sql)
      await client.query('INSERT INTO public.schema_migration (nome, hash) VALUES ($1, $2)', [
        m.nome,
        m.hash,
      ])
      process.stdout.write('ok\n')
    }
  } finally {
    await client.end()
  }
}

const executadoDiretamente = process.argv[1]?.endsWith('migrate.js') ?? false

if (executadoDiretamente) {
  const url = process.env['DATABASE_URL_ADMIN'] ?? process.env['DATABASE_URL']
  if (!url) {
    console.error('DATABASE_URL_ADMIN não definida.')
    process.exit(1)
  }
  migrate(url).then(
    () => process.stdout.write('migrations aplicadas\n'),
    (err: unknown) => {
      console.error(err)
      process.exit(1)
    },
  )
}
