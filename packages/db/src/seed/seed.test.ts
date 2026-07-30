import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gerarMassa, prng } from './gerador.js'
import { PERFIS } from './perfis.js'

const HOJE = new Date('2026-07-30T00:00:00Z')

test('a mesma semente produz exatamente a mesma massa', () => {
  // Sem determinismo, um bug que aparece na massa não pode ser reproduzido — e
  // "funciona na minha máquina" volta a ser uma frase válida.
  const a = gerarMassa({ semente: 7, contas: 12, dias: 60, hoje: HOJE })
  const b = gerarMassa({ semente: 7, contas: 12, dias: 60, hoje: HOJE })
  assert.deepEqual(a, b)
})

test('sementes diferentes produzem massas diferentes', () => {
  const a = gerarMassa({ semente: 1, contas: 12, dias: 60, hoje: HOJE })
  const b = gerarMassa({ semente: 2, contas: 12, dias: 60, hoje: HOJE })
  assert.notDeepEqual(a, b)
})

test('o gerador aleatório é estável entre execuções', () => {
  const r = prng(123)
  const primeiros = [r(), r(), r()]
  const r2 = prng(123)
  assert.deepEqual([r2(), r2(), r2()], primeiros)
})

test('todo perfil aparece pelo menos uma vez', () => {
  // Um sorteio azarado que deixasse um caso de borda de fora anularia o motivo
  // de a massa existir.
  const massa = gerarMassa({ contas: PERFIS.length, dias: 60, hoje: HOJE })
  const presentes = new Set(massa.map((c) => c.perfil))
  for (const p of PERFIS) assert.ok(presentes.has(p.id), `perfil ausente: ${p.id}`)
})

test('o perfil em queda tem uma quebra real nos últimos 30 dias', () => {
  const conta = gerarMassa({ contas: PERFIS.length, dias: 120, hoje: HOJE }).find(
    (c) => c.perfil === 'em_queda',
  )!
  const dias = conta.dias
  const recente = dias.slice(-30)
  const anterior = dias.slice(-60, -30)
  const media = (xs: typeof dias) => xs.reduce((a, d) => a + d.vidasAtivas30d, 0) / xs.length

  const queda = (media(recente) - media(anterior)) / media(anterior)
  // O gatilho dispara em −20%; a massa precisa cruzar esse limiar de verdade,
  // senão a fila nunca é exercitada.
  assert.ok(queda < -0.18, `queda de ${(queda * 100).toFixed(1)}% não cruza o limiar`)
})

test('fonte de engajamento ausente vem como nulo, nunca como zero', () => {
  // Zero significaria "ninguém usou", que é uma afirmação. A fonte não afirmou
  // nada — e é a diferença entre o driver sair da conta e entrar penalizando.
  const conta = gerarMassa({ contas: PERFIS.length, dias: 60, hoje: HOJE }).find(
    (c) => c.perfil === 'sem_engajamento',
  )!
  assert.ok(conta.dias.every((d) => d.mau === null && d.dau === null))

  const comFonte = gerarMassa({ contas: PERFIS.length, dias: 60, hoje: HOJE }).find(
    (c) => c.perfil === 'saudavel',
  )!
  assert.ok(comFonte.dias.every((d) => typeof d.mau === 'number'))
})

test('o recorte pequeno fica abaixo do mínimo de supressão', () => {
  const conta = gerarMassa({ contas: PERFIS.length, dias: 60, hoje: HOJE }).find(
    (c) => c.perfil === 'recorte_pequeno',
  )!
  const ultimo = conta.dias.at(-1)!
  assert.ok(ultimo.vidasAtivas30d < 10, `${ultimo.vidasAtivas30d} vidas ativas`)
})

test('o atraso envelhece dia a dia em vez de aparecer pronto', () => {
  const conta = gerarMassa({ contas: PERFIS.length, dias: 120, hoje: HOJE }).find(
    (c) => c.perfil === 'pdd',
  )!
  const dias = conta.dias
  const inicio = dias[0]!.diasAtrasoMax
  const fim = dias.at(-1)!.diasAtrasoMax
  assert.ok(fim > inicio, 'o atraso deveria crescer ao longo da série')
  assert.ok(fim >= 90, `${fim} dias não chega a PDD`)
})

test('conta nova tem histórico curto', () => {
  // Exercita os estados vazios: a tela precisa saber dizer "ainda não há série".
  const massa = gerarMassa({ contas: PERFIS.length, dias: 180, hoje: HOJE })
  const nova = massa.find((c) => c.perfil === 'novo')!
  const antiga = massa.find((c) => c.perfil === 'em_aviso')!
  assert.ok(nova.dias.length < 40, `${nova.dias.length} dias`)
  assert.equal(antiga.dias.length, 180)
})

test('a saída em curso tem levantada, MRR congelado e fim de aviso à frente', () => {
  const conta = gerarMassa({ contas: PERFIS.length, dias: 180, hoje: HOJE }).find(
    (c) => c.perfil === 'em_aviso',
  )!
  const x = conta.cancelamento!
  assert.equal(x.dataLevantada, '2026-07-15')
  // Levantou a mão há 15 dias com 90 de aviso: a receita só sai depois.
  assert.ok(new Date(x.dataFimAviso) > HOJE)
  assert.equal(x.mrrCentavosNaLevantada, conta.contrato.mrrCentavos)
})

test('cobertura cadastral baixa fica abaixo do gatilho de 60%', () => {
  const conta = gerarMassa({ contas: PERFIS.length, dias: 60, hoje: HOJE }).find(
    (c) => c.perfil === 'cobertura_baixa',
  )!
  const cobertura = conta.dias.at(-1)!.vidasElegiveis / conta.contrato.vidasContratadas
  assert.ok(cobertura < 0.6, `cobertura de ${(cobertura * 100).toFixed(0)}%`)
})

test('valores monetários são inteiros em centavos', () => {
  // Ponto flutuante em cálculo monetário é erro que só aparece na soma de
  // milhares de linhas — e aí já está no relatório.
  for (const c of gerarMassa({ contas: 12, dias: 30, hoje: HOJE })) {
    assert.ok(Number.isInteger(c.contrato.mrrCentavos))
    for (const d of c.dias) {
      assert.ok(Number.isInteger(d.gmvCentavos))
      assert.ok(Number.isInteger(d.cashbackGeradoCentavos))
      assert.ok(Number.isInteger(d.valorAbertoCentavos))
    }
  }
})

test('a série tem sazonalidade de fim de semana', () => {
  const conta = gerarMassa({ contas: PERFIS.length, dias: 180, hoje: HOJE }).find(
    (c) => c.perfil === 'saudavel',
  )!
  const porDia = (alvo: number[]) =>
    conta.dias
      .filter((d) => alvo.includes(new Date(`${d.dia}T00:00:00Z`).getUTCDay()))
      .reduce((a, d) => a + d.transacoes, 0) /
    conta.dias.filter((d) => alvo.includes(new Date(`${d.dia}T00:00:00Z`).getUTCDay())).length

  // Clube de benefício é usado sobretudo em dia útil; sem isso a série não se
  // parece com a real e qualquer análise de tendência fica ingênua.
  assert.ok(porDia([0]) < porDia([1, 2, 3, 4, 5]) * 0.6)
})
