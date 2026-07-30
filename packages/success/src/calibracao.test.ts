/**
 * A decisão de promover um gatilho.
 *
 * O que se testa aqui é sobretudo a RECUSA: em que condições o motor diz "ainda
 * não". Promover cedo demais é o erro caro — um gatilho ruidoso na fila do time
 * custa a confiança na fila inteira, e disso não se volta com ajuste de limiar.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { prontoParaPromover, TETO_FALSO_POSITIVO, type Calibracao } from './calibracao.js'

const BASE: Calibracao = {
  gatilho: 'G-04',
  familia: 'adesao',
  proposito: 'A queda que ainda dá tempo de reverter',
  promovido: false,
  fonteAusente: null,
  itens: 40,
  porCemContas: 9,
  estimado: [5, 12],
  veredito: 'ok',
  fechados: 20,
  falsosPositivos: 2,
  taxaFalsoPositivo: 0.1,
  diasEmSombra: 15,
}

const com = (p: Partial<Calibracao>): Calibracao => ({ ...BASE, ...p })

test('gatilho medido, dentro do volume e preciso, pode ser promovido', () => {
  assert.equal(prontoParaPromover(BASE).pronto, true)
})

test('os 14 dias são piso, não sugestão', () => {
  const r = prontoParaPromover(com({ diasEmSombra: 13 }))
  assert.equal(r.pronto, false)
  assert.match(r.porque, /13 de 14/)
})

test('volume acima do estimado barra a promoção', () => {
  // Três vezes acima não é três vezes mais problema: é limiar errado.
  const r = prontoParaPromover(com({ porCemContas: 34, veredito: 'acima' }))
  assert.equal(r.pronto, false)
  assert.match(r.porque, /revisar o limiar/)
})

test('volume ABAIXO do estimado não barra', () => {
  // Achar menos que o esperado pode ser base saudável — não é ruído, e segurar
  // um gatilho silencioso não protege ninguém.
  assert.equal(prontoParaPromover(com({ porCemContas: 2, veredito: 'abaixo' })).pronto, true)
})

test('falso positivo acima de 20% barra a promoção', () => {
  const r = prontoParaPromover(com({ taxaFalsoPositivo: TETO_FALSO_POSITIVO + 0.05 }))
  assert.equal(r.pronto, false)
  assert.match(r.porque, /25% de falso positivo/)
})

test('exatamente no teto ainda passa — o corte é acima de 20%', () => {
  assert.equal(prontoParaPromover(com({ taxaFalsoPositivo: TETO_FALSO_POSITIVO })).pronto, true)
})

test('sem julgamento suficiente não se promove por otimismo', () => {
  // taxa `null` significa "poucos fechamentos", não "zero falso positivo".
  const r = prontoParaPromover(com({ fechados: 3, taxaFalsoPositivo: null }))
  assert.equal(r.pronto, false)
  assert.match(r.porque, /só 3 item/)
})

test('gatilho que não produziu nada não é promovido por silêncio', () => {
  const r = prontoParaPromover(com({ itens: 0, diasEmSombra: 40 }))
  assert.equal(r.pronto, false)
  assert.match(r.porque, /nenhum item/)
})

test('gatilho sem fonte não é confundido com base saudável', () => {
  // Zero itens por falta de dado parece exatamente igual a zero itens por
  // ausência de problema — e são conclusões opostas.
  const r = prontoParaPromover(com({ itens: 0, fonteAusente: 'pesquisa de NPS' }))
  assert.equal(r.pronto, false)
  assert.match(r.porque, /sem fonte: pesquisa de NPS/)
})

test('já promovido não aparece como pronto para promover', () => {
  assert.equal(prontoParaPromover(com({ promovido: true })).pronto, false)
})

test('toda recusa vem com o motivo escrito, não só com o não', () => {
  const casos = [
    com({ diasEmSombra: 2 }),
    com({ veredito: 'acima', porCemContas: 40 }),
    com({ taxaFalsoPositivo: 0.9 }),
    com({ itens: 0 }),
    com({ fechados: 1, taxaFalsoPositivo: null }),
  ]
  for (const c of casos) {
    const r = prontoParaPromover(c)
    assert.equal(r.pronto, false)
    assert.ok(r.porque.length > 12, `motivo curto demais: "${r.porque}"`)
  }
})
