import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  verificarAnomalia,
  verificarCompletude,
  verificarFrescor,
  verificarReconciliacao,
  verificarReferencia,
  vereditoQualidade,
} from './quality.js'

const AGORA = new Date('2026-07-30T12:00:00Z')
const HORA = 3_600_000

// ── Frescor ──────────────────────────────────────────────────────────────────

test('fonte dentro do prazo passa', () => {
  const v = verificarFrescor('omie', new Date('2026-07-30T10:00:00Z'), 6 * HORA, AGORA)
  assert.equal(v.passou, true)
  assert.equal(v.acao, 'nenhuma')
})

test('fonte atrasada entra neutra e sinalizada, nunca com o último valor', () => {
  // Manter o último valor conhecido faz um cliente que parou de ser atendido
  // continuar parecendo saudável porque a integração caiu.
  const v = verificarFrescor('omie', new Date('2026-07-28T10:00:00Z'), 6 * HORA, AGORA)
  assert.equal(v.passou, false)
  assert.equal(v.acao, 'neutro_sinalizado')
  assert.match(v.detalhe, /50 h sem atualizar/)
})

test('fonte que nunca atualizou é tratada como atrasada', () => {
  const v = verificarFrescor('clevertap', null, HORA, AGORA)
  assert.equal(v.acao, 'neutro_sinalizado')
})

// ── Completude ───────────────────────────────────────────────────────────────

test('contagem fora da banda marca o snapshot como parcial, não o bloqueia', () => {
  // Bloquear significaria produto no ar sem número nenhum — pior que número
  // parcial e declarado.
  const v = verificarCompletude(500, 1000)
  assert.equal(v.passou, false)
  assert.equal(v.acao, 'snapshot_parcial')
})

test('variação dentro da banda passa', () => {
  assert.equal(verificarCompletude(1050, 1000).passou, true)
  assert.equal(verificarCompletude(850, 1000).passou, true)
})

test('primeira execução passa: não há contra o que comparar', () => {
  // Exigir referência inexistente travaria a carga inicial.
  assert.equal(verificarCompletude(1000, null).passou, true)
  assert.equal(verificarCompletude(1000, 0).passou, true)
})

// ── Anomalia ─────────────────────────────────────────────────────────────────

test('anomalia alarma sem bloquear', () => {
  // Cliente que dobra de tamanho produz anomalia legítima. Travar o dia por
  // causa dela ensinaria o time a ignorar o alarme.
  const v = verificarAnomalia(500, [100, 102, 98, 101, 99])
  assert.equal(v.passou, false)
  assert.equal(v.acao, 'alarme')
})

test('valor dentro da série passa', () => {
  assert.equal(verificarAnomalia(103, [100, 102, 98, 101, 99]).passou, true)
})

test('série curta não afirma desvio', () => {
  const v = verificarAnomalia(999, [100, 102])
  assert.equal(v.passou, true)
  assert.match(v.detalhe, /série curta/)
})

// ── Referência ───────────────────────────────────────────────────────────────

test('poucos registros sem conta vão para a fila de exceção', () => {
  const v = verificarReferencia(3, 1000)
  assert.equal(v.acao, 'fila_excecao')
})

test('acima de 2% sem conta é alarme: é mapeamento faltando em lote', () => {
  const v = verificarReferencia(50, 1000)
  assert.equal(v.acao, 'alarme')
  assert.match(v.detalhe, /5\.0%/)
})

test('tudo resolvido passa', () => {
  assert.equal(verificarReferencia(0, 1000).passou, true)
})

// ── Reconciliação ────────────────────────────────────────────────────────────

test('divergência acima da tolerância é crítica', () => {
  // É o único sinal que diz que um número já publicado está errado.
  const v = verificarReconciliacao(9000, 10000, 0.005)
  assert.equal(v.passou, false)
  assert.equal(v.acao, 'alarme_critico')
})

test('divergência dentro da tolerância passa', () => {
  assert.equal(verificarReconciliacao(10030, 10000, 0.005).passou, true)
})

// ── Veredito ─────────────────────────────────────────────────────────────────

test('o veredito adota a ação mais severa', () => {
  const { acao, falhas } = vereditoQualidade([
    verificarFrescor('a', new Date('2026-07-20T00:00:00Z'), HORA, AGORA), // neutro
    verificarReconciliacao(5000, 10000, 0.005), // crítico
    verificarCompletude(1000, 1000), // passa
  ])
  assert.equal(acao, 'alarme_critico')
  assert.equal(falhas.length, 2)
})

test('sem falhas, nenhuma ação', () => {
  const { acao, falhas } = vereditoQualidade([verificarCompletude(1000, 1000)])
  assert.equal(acao, 'nenhuma')
  assert.equal(falhas.length, 0)
})
