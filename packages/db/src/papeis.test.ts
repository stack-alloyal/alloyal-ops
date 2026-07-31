/**
 * A lista de papéis existe em dois lugares, e eles não podem divergir.
 *
 * `PAPEIS` em `@ops/auth` é o que o código conhece; o CHECK de `ops.user_role` é o
 * que o banco aceita. Manter os dois é deliberado — o CHECK impede papel inventado
 * por SQL solto, o tipo impede papel inventado por código.
 *
 * O que faltava era este teste. Eu adicionei três papéis no TypeScript e esqueci a
 * migration; a gravação explodiu com uma mensagem sobre a constraint, que não diz
 * nada sobre a causa. Comparar as duas listas custa uma asserção.
 *
 * Sem banco: lê o CHECK dos ARQUIVOS de migration, aplicando a última alteração.
 * Assim o portão roda no job rápido do CI e falha antes de qualquer deploy.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PAPEIS } from '@ops/auth'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** Os papéis aceitos pelo banco, segundo a última migration que mexeu no CHECK. */
function papeisDoBanco(): string[] {
  const arquivos = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  let ultimo: string[] | null = null
  for (const f of arquivos) {
    const sql = readFileSync(join(DIR, f), 'utf8')
    // Casa tanto o CREATE TABLE original quanto o ADD CONSTRAINT posterior.
    for (const m of sql.matchAll(/user_role_papel_check\s+CHECK\s*\(papel IN \(([^)]+)\)/gi)) {
      ultimo = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
    }
    if (/CREATE TABLE ops\.user_role/i.test(sql)) {
      const m = sql.match(/papel\s+text NOT NULL CHECK \(papel IN \(([\s\S]*?)\)\)/i)
      if (m) ultimo = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
    }
  }
  assert.ok(ultimo, 'não achei o CHECK de ops.user_role em nenhuma migration')
  return ultimo
}

test('o CHECK do banco aceita exatamente os papéis que o código declara', () => {
  const doBanco = papeisDoBanco().slice().sort()
  const doCodigo = [...PAPEIS].sort()
  assert.deepEqual(
    doBanco,
    doCodigo,
    'papel declarado em @ops/auth e não aceito pelo banco (ou o inverso) — falta uma migration',
  )
})

test('nenhum papel é declarado duas vezes', () => {
  assert.equal(new Set(PAPEIS).size, PAPEIS.length)
})

test('todo papel segue a convenção ops-*', () => {
  // O prefixo não é enfeite: os papéis vêm de GRUPOS do Workspace, e o prefixo é
  // o que permite listar os grupos relevantes sem enumerar nomes à mão.
  for (const p of PAPEIS) assert.match(p, /^ops-[a-z-]+$/)
})
