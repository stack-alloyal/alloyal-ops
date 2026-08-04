import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agendaEmPalavras, atrasado, type CicloNaTela } from './sincronizacao.js'

/**
 * `agendaEmPalavras` existe porque cron lido de cabeça é lido errado, e a diferença
 * entre "todo dia às 2h" e "a cada 15 minutos" é a diferença entre 1 carga por dia e 96.
 */
test('traduz as agendas que os ciclos daqui usam', () => {
  assert.equal(agendaEmPalavras('0 2 * * *'), 'todo dia às 02:00')
  assert.equal(agendaEmPalavras('30 7 * * *'), 'todo dia às 07:30')
  assert.equal(agendaEmPalavras('*/15 * * * *'), 'a cada 15 minutos')
  assert.equal(agendaEmPalavras('*/5 * * * *'), 'a cada 5 minutos')
  assert.equal(agendaEmPalavras('15 * * * *'), 'a cada hora')
})

test('sem agenda diz que é sob demanda, e não mente uma frequência', () => {
  assert.equal(agendaEmPalavras(null), 'sem agenda — só sob demanda')
  assert.equal(agendaEmPalavras('   '), 'sem agenda — só sob demanda')
})

test('agenda que não sabe traduzir volta COMO CRON, e não como frase inventada', () => {
  // Dizer "a cada hora" para um cron que roda a cada minuto é pior que não traduzir.
  for (const estranho of ['0 2 * * 1', '0 0 1 1 *', '0 2 1 * *', 'nao-e-cron', '1 2 3']) {
    const r = agendaEmPalavras(estranho)
    assert.ok(r === estranho || r.startsWith('dia 1'), `${estranho} virou "${r}"`)
  }
})

test('nunca devolve frase para cron de 5 campos que não reconhece', () => {
  assert.equal(agendaEmPalavras('0 2 * * 1'), '0 2 * * 1', 'segunda-feira não é "todo dia"')
})

// ─── Atraso ──────────────────────────────────────────────────────────────────

const ciclo = (over: Partial<CicloNaTela> = {}): CicloNaTela => ({
  id: 'C18',
  descricao: 'x',
  fonte: 'core',
  metodo: 'full',
  agenda: '0 2 * * *',
  fase: 'F1',
  implementado: true,
  ultimaEm: null,
  ultimoStatus: null,
  ultimoErro: null,
  linhasLidas: null,
  linhasGravadas: null,
  duracaoSegundos: null,
  ultimoSucessoEm: null,
  falhasSeguidas: 0,
  ...over,
})

const AGORA = new Date('2026-08-05T12:00:00Z')

test('ciclo diário sem sucesso nenhum está atrasado', () => {
  assert.equal(atrasado(ciclo(), AGORA), true)
})

test('sucesso de 10h atrás não é atraso', () => {
  const dez = new Date(AGORA.getTime() - 10 * 3_600_000)
  assert.equal(atrasado(ciclo({ ultimoSucessoEm: dez }), AGORA), false)
})

test('mais de 26h sem sucesso é atraso — a folga de 2h absorve atraso normal', () => {
  const vinteESeis = new Date(AGORA.getTime() - 27 * 3_600_000)
  assert.equal(atrasado(ciclo({ ultimoSucessoEm: vinteESeis }), AGORA), true)
  const vinteECinco = new Date(AGORA.getTime() - 25 * 3_600_000)
  assert.equal(atrasado(ciclo({ ultimoSucessoEm: vinteECinco }), AGORA), false)
})

test('ciclo NÃO implementado nunca conta como atrasado', () => {
  // Ele não roda por desenho. Marcá-lo de vermelho encheria a tela de alarme falso
  // e ensinaria a ignorar a cor.
  assert.equal(atrasado(ciclo({ implementado: false }), AGORA), false)
})

test('ciclo sem agenda nunca conta como atrasado', () => {
  assert.equal(atrasado(ciclo({ agenda: null }), AGORA), false)
})

test('agenda de minutos não é avaliada aqui — quem cobre é o alarme do executor', () => {
  assert.equal(atrasado(ciclo({ agenda: '*/15 * * * *' }), AGORA), false)
})
