/**
 * Portão: todo arquivo de teste é rodado pelo CI.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE ESTE PORTÃO EXISTE:                                                │
 * │                                                                            │
 * │ O `ci.yml` roda os testes NOMEANDO cada arquivo, um por um, em três jobs.   │
 * │ Isso é uma lista escrita à mão do que existe em disco — e lista duplicada   │
 * │ diverge, que é a regra que já obrigou `papeis.test.ts` e `migracoes.test.ts`│
 * │ a existirem.                                                               │
 * │                                                                            │
 * │ Ela JÁ tinha divergido quando este arquivo foi escrito: `fila.test.ts`      │
 * │ existia em `packages/success` e nenhum job o rodava. Escrever teste que     │
 * │ nunca roda é pior que não escrever — ele dá a impressão de cobertura que    │
 * │ não existe, e o `pnpm test` local também não o alcança, porque              │
 * │ `@pulse/success` não tem script `test`.                                    │
 * │                                                                            │
 * │ Roda sem build e sem banco: é varredura de arquivo.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function testes(dir, achados = []) {
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome === '.next' || nome === 'dist' || nome === '.turbo') continue
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) testes(p, achados)
    else if (/\.test\.(ts|mjs)$/.test(nome)) achados.push(p)
  }
  return achados
}

/**
 * Exceções declaradas. O motivo é obrigatório e fica AQUI, à vista de quem
 * adicionar a próxima — não num comentário perdido no `ci.yml`.
 */
const FORA_DO_CI = new Map([
  [
    'packages/db/src/rls.test.ts',
    'precisa de Postgres com os roles criados; roda em `make db-test`, não no CI',
  ],
])

test('todo arquivo de teste aparece no ci.yml', () => {
  const ci = readFileSync(join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8')
  const arquivos = [...testes(join(RAIZ, 'packages')), ...testes(join(RAIZ, 'apps'))]
  assert.ok(arquivos.length > 20, 'não varri os testes — a estrutura de pastas mudou?')

  const ausentes = []
  for (const caminho of arquivos) {
    const rel = relative(RAIZ, caminho)
    if (FORA_DO_CI.has(rel)) continue
    // O CI pode nomear o arquivo COMPILADO (`dist/x.test.js`), o `.mjs` direto,
    // ou o próprio `.ts` quando roda por remoção de tipos — é o caso de
    // `@pulse/ui`, que não emite `dist`. As três formas valem.
    const base = rel.split('/').pop()
    const compilado = base.replace(/\.ts$/, '.js')
    if (!ci.includes(base) && !ci.includes(compilado)) ausentes.push(rel)
  }

  assert.deepEqual(
    ausentes,
    [],
    `estes testes NUNCA rodam — nomeie cada um no .github/workflows/ci.yml, ` +
      `ou declare a exceção com motivo em FORA_DO_CI:\n  ${ausentes.join('\n  ')}`,
  )
})

test('a exceção declarada ainda existe em disco', () => {
  // Exceção de arquivo apagado é ruído que engana quem lê a lista depois.
  for (const [rel, motivo] of FORA_DO_CI) {
    assert.ok(motivo.length >= 20, `o motivo de ${rel} é curto demais para explicar`)
    assert.doesNotThrow(
      () => statSync(join(RAIZ, rel)),
      `${rel} está declarado em FORA_DO_CI mas não existe mais — apague a linha`,
    )
  }
})
