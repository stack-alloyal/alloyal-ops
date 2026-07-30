import assert from 'node:assert/strict'
import { test } from 'node:test'

import { janelaDeLeitura, SOBREPOSICAO_MS, todosOsCiclos } from './cycle.js'
import { CICLOS_ESPERADOS_PELO_SNAPSHOT } from './cycles/index.js'
import './cycles/index.js'

test('todo ciclo declarado tem chave natural', () => {
  for (const c of todosOsCiclos()) {
    assert.ok(c.chaveNatural.length > 0, `${c.id} sem chave natural`)
  }
})

test('C5 é o único com degradação de alarme crítico', () => {
  const criticos = todosOsCiclos().filter((c) => c.emFalha.degradacao === 'alarme_critico')
  assert.deepEqual(
    criticos.map((c) => c.id),
    ['C5'],
    'perda irrecuperável só se aplica ao ledger de MRR',
  )
})

test('nenhum ciclo bloqueia o snapshot; a degradação é parcial', () => {
  // A v1.0 usava "bloqueia o dia". Snapshot bloqueado = produto sem número.
  for (const c of todosOsCiclos()) {
    assert.notEqual(c.emFalha.degradacao as string, 'bloqueia_snapshot')
  }
})

test('os ciclos que o snapshot espera estão declarados ou previstos', () => {
  const declarados = new Set(todosOsCiclos().map((c) => c.id))
  // C6 (CleverTap) entra na F2 e ainda não está declarado — é esperado.
  const faltando = CICLOS_ESPERADOS_PELO_SNAPSHOT.filter((id) => !declarados.has(id))
  assert.deepEqual(faltando, ['C6'])
})

test('a janela de leitura aplica a sobreposição de segurança', () => {
  const wm = new Date('2026-07-26T12:00:00Z')
  const agora = new Date('2026-07-26T12:15:00Z')
  const j = janelaDeLeitura(wm, agora)
  assert.equal(j.de.getTime(), wm.getTime() - SOBREPOSICAO_MS)
  assert.equal(j.ate.getTime(), agora.getTime())
})

test('sem watermark a janela começa do início', () => {
  const j = janelaDeLeitura(null, new Date('2026-07-26T12:00:00Z'))
  assert.equal(j.de.getTime(), 0)
})
