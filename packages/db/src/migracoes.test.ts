/**
 * Portão sobre os ARQUIVOS de migration, sem precisar de banco.
 *
 * Existe por causa de um defeito real: as migrations 0001–0009 se envolvem em
 * `BEGIN/COMMIT`, e três que escrevi depois não. O executor manda o arquivo
 * inteiro numa consulta só, então sem a transação explícita cada comando
 * confirma sozinho — e uma falha no meio deixa o schema em estado misto, com
 * metade das colunas criadas. Foi exatamente o que aconteceu, e o sintoma foi
 * "relation already exists" na segunda tentativa, que não diz nada sobre a causa.
 *
 * A revisão de código não pega isso: o arquivo parece certo. Uma asserção pega.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

const arquivos = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

test('há migrations para verificar', () => {
  assert.ok(arquivos.length > 0, `nenhum .sql em ${DIR}`)
})

test('toda migration roda em uma transação', () => {
  // Sem isto, falha no meio do arquivo deixa o schema meio migrado — e o próximo
  // que rodar recebe um erro sobre o sintoma, não sobre a causa.
  for (const f of arquivos) {
    const sql = readFileSync(join(DIR, f), 'utf8')
    assert.match(sql, /^\s*BEGIN;\s*$/m, `${f} não abre transação`)
    assert.match(sql, /^\s*COMMIT;\s*$/m, `${f} não fecha transação`)
    assert.equal(
      (sql.match(/^\s*BEGIN;\s*$/gm) ?? []).length,
      1,
      `${f} abre transação mais de uma vez`,
    )
  }
})

test('a numeração é sequencial e sem lacuna', () => {
  // Lacuna significa migration perdida em algum lugar — ou renomeada depois de
  // aplicada, que o guarda de hash do executor recusaria em produção.
  const numeros = arquivos.map((f) => Number(f.slice(0, 4)))
  for (const [i, n] of numeros.entries()) {
    assert.equal(n, i + 1, `esperava ${String(i + 1).padStart(4, '0')}, achei ${arquivos[i]}`)
  }
})

test('nenhum objeto é criado duas vezes em migrations diferentes', () => {
  // Isto pegou um erro meu: escrevi uma migration "adicionando" um índice que já
  // existia desde a 0007. Numa base já migrada nada acontece — o executor pula
  // arquivos aplicados. Numa base NOVA a migration explode, e o erro fala do
  // sintoma ("relation already exists"), não da causa.
  const criados = new Map<string, string>()
  const padrao = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/gi
  for (const f of arquivos) {
    const sql = readFileSync(join(DIR, f), 'utf8')
    for (const m of sql.matchAll(padrao)) {
      const nome = m[1]!.toLowerCase()
      const antes = criados.get(nome)
      assert.equal(antes, undefined, `índice ${nome} criado em ${antes} e de novo em ${f}`)
      criados.set(nome, f)
    }
  }
})

test('coluna adicionada não repete coluna já adicionada', () => {
  const criadas = new Map<string, string>()
  const padrao = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/gi
  const tabela = /ALTER\s+TABLE\s+([a-z0-9_.]+)/gi
  for (const f of arquivos) {
    const sql = readFileSync(join(DIR, f), 'utf8')
    // Aproximação de propósito: casa ALTER TABLE com os ADD COLUMN seguintes até
    // o próximo ALTER. Parser de SQL aqui seria mais frágil que o problema.
    const blocos = sql.split(tabela)
    for (let i = 1; i < blocos.length; i += 2) {
      const alvo = blocos[i]!.toLowerCase()
      for (const m of (blocos[i + 1] ?? '').matchAll(padrao)) {
        const chave = `${alvo}.${m[1]!.toLowerCase()}`
        const antes = criadas.get(chave)
        assert.equal(antes, undefined, `coluna ${chave} adicionada em ${antes} e de novo em ${f}`)
        criadas.set(chave, f)
      }
    }
  }
})

test('nome de arquivo descreve o que a migration faz', () => {
  for (const f of arquivos) {
    const nome = f.slice(5, -4)
    assert.ok(nome.length >= 4, `${f}: nome curto demais para dizer o que faz`)
    assert.match(nome, /^[a-z0-9_]+$/, `${f}: use minúsculas e sublinhado`)
  }
})

test('toda migration começa explicando por que existe', () => {
  // Migration é o registro de uma decisão de modelagem. Sem a primeira linha
  // dizendo o motivo, seis meses depois ninguém sabe se a coluna ainda serve.
  for (const f of arquivos) {
    const sql = readFileSync(join(DIR, f), 'utf8')
    const primeira = sql.split('\n')[0] ?? ''
    assert.match(primeira, /^--/, `${f} não começa com comentário`)
    assert.ok(primeira.length > 12, `${f}: cabeçalho vazio demais`)
  }
})
