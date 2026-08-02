import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rotaInterna } from './rotaInterna.ts'

/**
 * O `rd` vem do `$request_uri` — escolhido por quem AINDA NÃO se autenticou — e
 * vira o `href` do botão que a vítima clica logo antes de digitar a senha do
 * Google. Cada caso abaixo é uma forma de sair do domínio parecendo caminho
 * interno.
 */

test('rota interna comum passa inteira, com query', () => {
  assert.equal(rotaInterna('/success/fila'), '/success/fila')
  assert.equal(rotaInterna('/success/relatorio?conta=42'), '/success/relatorio?conta=42')
})

test('sem valor não vira retorno', () => {
  for (const vazio of [null, undefined, '']) {
    assert.equal(rotaInterna(vazio), undefined)
  }
})

test('URL absoluta é recusada', () => {
  for (const fora of ['https://evil.com', 'http://evil.com', 'javascript:alert(1)']) {
    assert.equal(rotaInterna(fora), undefined, `${fora} deveria ser recusada`)
  }
})

test('protocolo-relativa é recusada — começa com barra e SAI do domínio', () => {
  // `//evil.com` passa em `startsWith('/')`. É o caso que a checagem ingênua
  // deixa passar, e o navegador o interpreta como https://evil.com.
  assert.equal(rotaInterna('//evil.com'), undefined)
  assert.equal(rotaInterna('//evil.com/pagina'), undefined)
})

test('barra invertida é recusada — Chrome e Firefox a leem como barra', () => {
  assert.equal(rotaInterna('/\\evil.com'), undefined)
})

test('controle e espaço são recusados — quebram cabeçalho e URL', () => {
  assert.equal(rotaInterna('/fila\nLocation: https://evil.com'), undefined)
  assert.equal(rotaInterna('/fila\rX: 1'), undefined)
  assert.equal(rotaInterna('/fila com espaco'), undefined)
  assert.equal(rotaInterna('/fila\ttab'), undefined)
})

test('o próprio fluxo de login não vira retorno — seria laço', () => {
  assert.equal(rotaInterna('/oauth2/start'), undefined)
  assert.equal(rotaInterna('/oauth2/callback?code=x'), undefined)
  assert.equal(rotaInterna('/'), undefined)
})
