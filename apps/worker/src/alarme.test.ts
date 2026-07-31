/**
 * Alarme com falha induzida, POR CICLO — critério de lançamento §17.4 do PRD.
 *
 * O que existia antes: uma asserção de que o C5 é o único com degradação crítica.
 * Isso verifica a DECLARAÇÃO, não o comportamento. Um ciclo pode declarar
 * `alarmeApos: 2` e nunca alarmar, porque a comparação que decide isso estava solta
 * dentro do JSX do painel — sem teste possível.
 *
 * Aqui a falha é induzida contra a política real de cada ciclo declarado, no limiar
 * e nos dois lados dele. Percorrer `todosOsCiclos()` em vez de listar ciclos à mão é
 * o que faz um ciclo novo ser coberto no dia em que é declarado, e não no dia em que
 * alguém lembra de acrescentá-lo aqui.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decidirAlarme, politicaCoerente } from '@ops/metrics'

import { todosOsCiclos } from './cycle.js'
import './cycles/index.js'

test('sem falha, nenhum ciclo alarma', () => {
  for (const c of todosOsCiclos()) {
    assert.equal(decidirAlarme(0, c.emFalha).nivel, 'silencio', `${c.id} alarmou sem falha`)
  }
})

test('no limiar declarado, todo ciclo alarma', () => {
  for (const c of todosOsCiclos()) {
    const a = decidirAlarme(c.emFalha.alarmeApos, c.emFalha)
    assert.notEqual(
      a.nivel,
      'silencio',
      `${c.id} tem alarmeApos ${c.emFalha.alarmeApos} e ficou em silêncio no limiar`,
    )
  }
})

test('uma falha antes do limiar, o ciclo tolera — menos o crítico', () => {
  for (const c of todosOsCiclos()) {
    const antes = c.emFalha.alarmeApos - 1
    if (antes < 1) continue // limiar 1 não tem "antes"
    const a = decidirAlarme(antes, c.emFalha)
    if (c.emFalha.degradacao === 'alarme_critico') {
      assert.equal(a.nivel, 'critico', `${c.id} é irrecuperável e tolerou ${antes} falha(s)`)
    } else {
      assert.equal(a.nivel, 'silencio', `${c.id} alarmou antes do limiar declarado`)
    }
  }
})

test('perda irrecuperável alarma na PRIMEIRA falha', () => {
  const criticos = todosOsCiclos().filter((c) => c.emFalha.degradacao === 'alarme_critico')
  assert.ok(criticos.length > 0, 'nenhum ciclo crítico declarado — o C5 deveria ser')
  for (const c of criticos) {
    const a = decidirAlarme(1, c.emFalha)
    assert.equal(a.nivel, 'critico', `${c.id}: uma falha já é perda que não volta`)
  }
})

test('toda política declarada é coerente', () => {
  // Um `alarmeApos: 3` num ciclo crítico é mentira para quem lê a declaração para
  // decidir se pode dormir tranquilo. `decidirAlarme` ignora, mas a declaração fica.
  const incoerentes = todosOsCiclos()
    .map((c) => ({ id: c.id, erro: politicaCoerente(c.emFalha) }))
    .filter((x) => x.erro !== null)
    .map((x) => `${x.id}: ${x.erro}`)
  assert.deepEqual(incoerentes, [])
})

test('todo motivo de alarme carrega número', () => {
  // Mesma regra dos itens de trabalho: "o ciclo falhou" informa sem instruir.
  // "3 falhas seguidas, limiar é 2" diz o que fazer e desde quando.
  for (const c of todosOsCiclos()) {
    for (const n of [1, c.emFalha.alarmeApos, c.emFalha.alarmeApos + 3]) {
      const a = decidirAlarme(n, c.emFalha)
      assert.match(a.motivo, /\d/, `${c.id} com ${n} falha(s): motivo sem número — "${a.motivo}"`)
    }
  }
})

test('mais falhas que o limiar não rebaixa o alarme', () => {
  // Regressão possível numa comparação de faixa (`=== alarmeApos` em vez de `>=`):
  // o alarme acenderia no limiar exato e apagaria depois, justamente quando piora.
  for (const c of todosOsCiclos()) {
    const limiar = decidirAlarme(c.emFalha.alarmeApos, c.emFalha)
    const muito = decidirAlarme(c.emFalha.alarmeApos + 10, c.emFalha)
    const peso = { silencio: 0, aviso: 1, critico: 2 }
    assert.ok(
      peso[muito.nivel] >= peso[limiar.nivel],
      `${c.id}: ${c.emFalha.alarmeApos + 10} falhas alarmam menos que ${c.emFalha.alarmeApos}`,
    )
  }
})
