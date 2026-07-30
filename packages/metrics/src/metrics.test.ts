import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allMetrics, metricsPendentes } from './define.js'
import { DRIVERS, PESO_TOTAL_ESPERADO, calcularScore, faixaPorRegra } from './score.js'
import { faixaAtraso } from './catalog/conta.js'
import { geraItemDeTrabalho, severidade } from './churn.js'
import './index.js'

// ─── Governança do dicionário ────────────────────────────────────────────────

test('toda métrica tem dono e explicação', () => {
  for (const m of allMetrics()) {
    assert.ok(m.dono.trim().length > 0, `${m.id} sem dono`)
    assert.ok(m.explicacao.trim().length > 0, `${m.id} sem explicação`)
  }
})

test('métricas com dono pendente estão visíveis, não escondidas', () => {
  // Não é falha: é dívida declarada. O painel de governança mostra esta lista.
  const pendentes = metricsPendentes().map((m) => m.id)
  assert.ok(pendentes.includes('adesao_30d'), 'adesao_30d depende de DEF-01')
  assert.ok(pendentes.includes('nrr'), 'nrr depende de DEF-04')
})

// ─── Score ───────────────────────────────────────────────────────────────────

test('os pesos dos nove drivers somam 100', () => {
  const soma = DRIVERS.reduce((acc, d) => acc + d.peso, 0)
  assert.equal(soma, PESO_TOTAL_ESPERADO)
})

test('driver ausente é renormalizado, nunca tratado como zero', () => {
  // Um cliente perfeito nos drivers disponíveis não pode ser penalizado por
  // integração que ainda não existe. Zero seria exatamente essa penalidade.
  const r = calcularScore([
    { id: 'S-FIN', valor: 100 },
    { id: 'S-ADO', valor: 100 },
    { id: 'S-ENG', valor: null },
  ])
  assert.equal(r.valor, 100)
  assert.equal(r.driversUsados, 2)
  assert.equal(r.parcial, true)
  assert.ok(r.ausentes.includes('S-ENG'))
})

test('score sem nenhum driver é nulo, não zero', () => {
  const r = calcularScore([])
  assert.equal(r.valor, null)
  assert.equal(r.faixa, null)
})

test('a faixa por regra segue o pior driver, não a média', () => {
  // O caso que a média esconde: cliente ótimo em quase tudo e inadimplente.
  const faixa = faixaPorRegra([
    { id: 'S-ADO', valor: 95 },
    { id: 'S-USO', valor: 90 },
    { id: 'S-FIN', valor: 10 },
  ])
  assert.equal(faixa, 'critico')
})

// ─── Churn silencioso ────────────────────────────────────────────────────────

test('faixa de atraso respeita as fronteiras', () => {
  assert.equal(faixaAtraso(0), 'adimplente')
  assert.equal(faixaAtraso(1), '1_30')
  assert.equal(faixaAtraso(30), '1_30')
  assert.equal(faixaAtraso(31), '31_60')
  assert.equal(faixaAtraso(91), 'acima_90')
})

test('cliente adimplente e engajado é a única célula que não gera trabalho', () => {
  assert.equal(severidade('saudavel', 'adimplente'), 'saudavel')
  assert.equal(geraItemDeTrabalho(severidade('saudavel', 'adimplente')), false)
  // Adimplente com engajamento nulo já é risco alto: paga e não usa é saída anunciada.
  assert.equal(severidade('nulo', 'adimplente'), 'risco_alto')
  assert.equal(geraItemDeTrabalho(severidade('nulo', 'adimplente')), true)
})

test('acima de 90 dias é sempre PDD, qualquer que seja o engajamento', () => {
  for (const eng of ['saudavel', 'em_queda', 'baixo', 'nulo'] as const) {
    assert.equal(severidade(eng, 'acima_90'), 'pdd')
  }
})
