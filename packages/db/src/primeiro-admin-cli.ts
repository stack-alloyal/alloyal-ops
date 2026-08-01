/**
 * CLI do primeiro acesso. Uso:
 *   DATABASE_URL_ADMIN=... node dist/primeiro-admin-cli.js nome@alloyal.com.br
 */
import { primeiroAdmin } from './primeiro-admin.js'

const url = process.env['DATABASE_URL_ADMIN'] ?? process.env['DATABASE_URL']
const email = process.argv[2]

if (!url) {
  console.error('defina DATABASE_URL_ADMIN')
  process.exit(1)
}
if (!email) {
  console.error('uso: primeiro-admin-cli <email@alloyal.com.br>')
  process.exit(1)
}

primeiroAdmin(url, email, process.env['USER'] ?? 'desconhecido')
  .then((r) => {
    // `console.error` e não `log`: o lint da casa só permite warn/error, e num CLI a
    // saída informativa em stderr é o que mantém stdout limpo para quem encadeia.
    console.error(`${r.email} recebeu ${r.papel}.`)
    console.error('A partir daqui, todo acesso passa por Configurações → Acessos.')
  })
  .catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })
