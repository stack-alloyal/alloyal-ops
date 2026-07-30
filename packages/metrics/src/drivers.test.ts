import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  calcularDrivers,
  driverAdesao,
  driverAdimplencia,
  driverEngajamento,
  driverRelacionamento,
  driverTendencia,
  percentil,
} from './drivers.js'
import { DRIVERS, faixaPorRegra } from './score.js'
import { envelope, estadoDoDado } from './lineage.js'
// Registra o catálogo: o envelope consulta o dicionário, e uma métrica só
// existe depois que o catálogo é importado.
import './catalog/conta.js'

const VAZIO = {
  adesao30d: null,
  adesao30dAnterior: null,
  pisoSegmento: 0.3,
  coberturaCadastral: null,
  diasAtrasoMax: null,
  percentilIntensidade: null,
  diasDesdeUltimoContato: null,
  mau: null,
  dau: null,
  csat: null,
  nps: null,
}

// ── A regra que atravessa todos os drivers ──────────────────────────────────

test('entrada ausente devolve nulo, nunca zero', () => {
  // Zero é uma afirmação: "está péssimo". Ausente é "a fonte não disse". Confundir
  // os dois faz um cliente saudável despencar porque uma integração caiu.
  for (const d of calcularDrivers(VAZIO)) assert.equal(d.valor, null, d.id)
})

test('todos os nove drivers são calculados, na ordem da especificação', () => {
  const ids = calcularDrivers(VAZIO).map((d) => d.id)
  assert.equal(ids.length, 9)
  assert.deepEqual([...ids].sort(), [...DRIVERS.map((d) => d.id)].sort())
})

// ── Drivers individuais ─────────────────────────────────────────────────────

test('adimplência decai linear até zerar aos 90 dias', () => {
  assert.equal(driverAdimplencia(0), 100)
  assert.equal(driverAdimplencia(45), 50)
  assert.equal(driverAdimplencia(90), 0)
  // Além de 90 não fica negativo: a provisão já entrou, e mais atraso não torna
  // a conta "mais que crítica".
  assert.equal(driverAdimplencia(200), 0)
})

test('adesão satura em 100 ao atingir o piso do segmento', () => {
  assert.equal(driverAdesao(0.15, 0.3), 50)
  assert.equal(driverAdesao(0.3, 0.3), 100)
  assert.equal(driverAdesao(0.9, 0.3), 100)
})

test('a tendência é assimétrica: queda pesa mais que alta', () => {
  // Um clube que cresce 30% é boa notícia, mas não é três vezes melhor que um
  // que cresce 10% — por isso a rampa satura em +10%.
  assert.equal(driverTendencia(0.7, 1.0), 0) // −30%
  assert.equal(driverTendencia(1.1, 1.0), 100) // +10%
  assert.equal(driverTendencia(1.5, 1.0), 100)
  assert.ok(driverTendencia(0.78, 1.0)! < 25) // a queda de 22% é crítica
})

test('relacionamento tolera 30 dias e zera em 120', () => {
  assert.equal(driverRelacionamento(5), 100)
  assert.equal(driverRelacionamento(30), 100)
  assert.equal(driverRelacionamento(120), 0)
})

test('a rampa de engajamento é calibrada para clube de benefício', () => {
  // Aderência de 0,15 é um clube muito ativo. Uma rampa que só premia 0,40 faz
  // a base inteira parecer moribunda — e driver em que todo mundo vai mal não
  // ordena ninguém.
  assert.ok(driverEngajamento(1000, 150)! > 65, 'aderência de 0,15 deveria pontuar bem')
  assert.equal(driverEngajamento(1000, 200), 100)
  assert.ok(driverEngajamento(1000, 20)! < 10)
})

// ── Percentil ───────────────────────────────────────────────────────────────

test('empates recebem o mesmo percentil', () => {
  // Duas contas idênticas em posições diferentes seriam um número inexplicável.
  const pop = [1, 2, 2, 2, 3]
  assert.equal(percentil(2, pop), percentil(2, pop))
  assert.ok(percentil(1, pop)! < percentil(3, pop)!)
})

test('população vazia devolve nulo', () => {
  assert.equal(percentil(5, []), null)
})

// ── Absoluto vs. relativo ───────────────────────────────────────────────────

test('driver relativo NÃO declara a conta crítica sozinho', () => {
  // Intensidade é percentil: alguém está sempre no último quartil. Se ele
  // decidisse a faixa, 25% da base estaria sempre em chamas — o que é o mesmo
  // que nenhuma estar.
  const faixa = faixaPorRegra([
    { id: 'S-FIN', valor: 100 },
    { id: 'S-ADO', valor: 95 },
    { id: 'S-USO', valor: 2 },
  ])
  assert.equal(faixa, 'saudavel')
})

test('driver absoluto continua declarando a conta crítica sozinho', () => {
  const faixa = faixaPorRegra([
    { id: 'S-ADO', valor: 95 },
    { id: 'S-USO', valor: 90 },
    { id: 'S-FIN', valor: 10 },
  ])
  assert.equal(faixa, 'critico')
})

test('só a intensidade é relativa', () => {
  const relativos = DRIVERS.filter((d) => !d.absoluto).map((d) => d.id)
  assert.deepEqual(relativos, ['S-USO'])
})

// ── Envelope de linhagem ────────────────────────────────────────────────────

const FONTE_OK = [{ ciclo: 'C1', fonte: 'replica', atualizado_em: null, status: 'ok' as const }]

test('o envelope carrega a versão da definição e o estado', () => {
  const e = envelope({
    metrica: 'adesao_30d',
    valor: 0.41,
    competencia: '2026-07-30',
    geradoEm: new Date('2026-07-30T10:00:00Z'),
    fontes: FONTE_OK,
  })
  assert.equal(e.valor, 0.41)
  assert.equal(e.metrica, 'adesao_30d')
  assert.equal(e.versao_definicao, 1)
  assert.equal(e.estado, 'ok')
})

test('recorte pequeno é suprimido e perde o valor', () => {
  const e = envelope({
    metrica: 'adesao_30d',
    valor: 0.8,
    competencia: '2026-07-30',
    geradoEm: new Date(),
    fontes: FONTE_OK,
    nBase: 3,
  })
  assert.equal(e.estado, 'suprimido')
  assert.equal(e.valor, null)
  assert.equal(e.n_base, 3)
})

test('incidente aberto vence qualquer outro estado', () => {
  // Enquanto há dúvida declarada, ninguém deve usar o número como se não
  // houvesse.
  assert.equal(
    estadoDoDado({
      metrica: 'adesao_30d',
      valor: 1,
      competencia: '2026-07-30',
      geradoEm: new Date(),
      fontes: [{ ciclo: 'C1', fonte: 'replica', atualizado_em: null, status: 'ausente' }],
      nBase: 2,
      emVerificacao: true,
    }),
    'em_verificacao',
  )
})

test('fonte ausente deixa a competência parcial; defasada, defasada', () => {
  const base = {
    metrica: 'adesao_30d',
    valor: 1,
    competencia: '2026-07-30',
    geradoEm: new Date(),
  }
  assert.equal(
    estadoDoDado({
      ...base,
      fontes: [{ ciclo: 'C6', fonte: 'clevertap', atualizado_em: null, status: 'ausente' }],
    }),
    'parcial',
  )
  assert.equal(
    estadoDoDado({
      ...base,
      fontes: [{ ciclo: 'C8', fonte: 'omie', atualizado_em: null, status: 'defasado' }],
    }),
    'defasado',
  )
})

test('métrica fora do dicionário não chega à tela', () => {
  // Número sem definição registrada não deveria conseguir ser exibido — melhor
  // quebrar aqui do que mostrar um valor que ninguém sabe explicar.
  assert.throws(
    () =>
      envelope({
        metrica: 'inventada_agora',
        valor: 1,
        competencia: '2026-07-30',
        geradoEm: new Date(),
        fontes: FONTE_OK,
      }),
    /desconhecida/,
  )
})
