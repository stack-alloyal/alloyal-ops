import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  avaliarGatilhos,
  umPorFamilia,
  ATRASO_ITEM_FINANCEIRO,
  GATILHOS,
  type EstadoConta,
} from './gatilhos.js'

const BASE: EstadoConta = {
  accountId: 'c1',
  competencia: '2026-07-30',
  csmEmail: 'ana@alloyal.com.br',
  adesao30d: 0.45,
  adesao30dAnterior: 0.44,
  pisoSegmento: 0.25,
  competenciasSobPiso: 0,
  vidasElegiveis: 900,
  vidasContratadas: 1000,
  coberturaCadastral: 0.9,
  diasDesdeGoLive: 400,
  diasAtrasoMax: 0,
  valorAbertoCentavos: 0,
  diasSemContato: 10,
  diasParaVigenciaFim: 300,
  severidadeChurnSilencioso: null,
  faixaEngajamento: 'saudavel',
  nps: null,
  horasIndisponibilidade: null,
  marcosAtrasados: null,
  segmentoMudou: null,
  produtosAusentes: null,
}

const com = (p: Partial<EstadoConta>): EstadoConta => ({ ...BASE, ...p })
const ids = (e: EstadoConta) => avaliarGatilhos(e).map((c) => c.gatilho)

// ── O caso normal ───────────────────────────────────────────────────────────

test('conta saudável não gera nenhum item', () => {
  // Se o caso normal gerar item, a fila deixa de significar alguma coisa.
  assert.deepEqual(ids(BASE), [])
})

// ── Inadimplência: faixas exclusivas ────────────────────────────────────────

test('as faixas de atraso não se sobrepõem', () => {
  // Um cliente com 95 dias de atraso não pode gerar três itens financeiros.
  assert.deepEqual(ids(com({ diasAtrasoMax: 15 })), [])
  assert.deepEqual(ids(com({ diasAtrasoMax: 38 })), ['G-01'])
  assert.deepEqual(ids(com({ diasAtrasoMax: 70 })), ['G-02'])
  assert.deepEqual(ids(com({ diasAtrasoMax: 95 })), ['G-03'])
})

test('o motivo do atraso traz o número e o valor', () => {
  const c = avaliarGatilhos(com({ diasAtrasoMax: 38, valorAbertoCentavos: 1_240_000 }))[0]!
  assert.match(c.motivo, /38 dias/)
  assert.match(c.motivo, /R\$\s?12\.400/)
})

test('aos 60 dias o motivo diz quanto falta para a provisão', () => {
  // É a informação que transforma "cobrar" em "cobrar agora".
  const c = avaliarGatilhos(com({ diasAtrasoMax: 70 }))[0]!
  assert.match(c.motivo, /20 dias da provisão/)
  assert.equal(c.prioridade, 'critica')
})

test('a provisão é decisão do Financeiro, não do CS', () => {
  const c = avaliarGatilhos(com({ diasAtrasoMax: 95 }))[0]!
  assert.equal(c.donoPapel, 'financeiro')
})

// ── Adesão ──────────────────────────────────────────────────────────────────

test('a queda de 22% dispara e o motivo mostra a transição', () => {
  const c = avaliarGatilhos(com({ adesao30d: 0.32, adesao30dAnterior: 0.41 }))[0]!
  assert.equal(c.gatilho, 'G-04')
  assert.match(c.motivo, /caiu 22%/)
  assert.match(c.motivo, /41% → 32%/)
})

test('queda menor que 20% não dispara', () => {
  assert.equal(ids(com({ adesao30d: 0.37, adesao30dAnterior: 0.44 })).includes('G-04'), false)
})

test('adesão sob o piso exige duas competências, não uma', () => {
  // Uma competência pode ser sazonalidade — e item disparado por sazonalidade é
  // o primeiro que o time aprende a ignorar.
  const abaixo = { adesao30d: 0.1, adesao30dAnterior: 0.1, pisoSegmento: 0.25 }
  assert.equal(ids(com({ ...abaixo, competenciasSobPiso: 1 })).includes('G-05'), false)
  assert.equal(ids(com({ ...abaixo, competenciasSobPiso: 2 })).includes('G-05'), true)
})

// ── Onboarding ──────────────────────────────────────────────────────────────

test('cobertura baixa só dispara depois de 30 dias de go-live', () => {
  // Antes disso, base incompleta é o estado normal de uma implantação.
  const baixa = { coberturaCadastral: 0.52, vidasElegiveis: 520, vidasContratadas: 1000 }
  assert.equal(ids(com({ ...baixa, diasDesdeGoLive: 10 })).includes('G-06'), false)
  assert.equal(ids(com({ ...baixa, diasDesdeGoLive: 45 })).includes('G-06'), true)
})

test('o motivo da cobertura diz quantas vidas faltam', () => {
  const c = avaliarGatilhos(
    com({ coberturaCadastral: 0.52, vidasElegiveis: 520, vidasContratadas: 1000, diasDesdeGoLive: 45 }),
  ).find((x) => x.gatilho === 'G-06')!
  assert.match(c.motivo, /520 de 1000/)
  assert.match(c.motivo, /faltam 480/)
})

// ── Churn silencioso ────────────────────────────────────────────────────────

test('o motivo do churn silencioso traz os DOIS vetores', () => {
  // É o que faz o CSM entender que "paga em dia e parou de usar" não é o mesmo
  // caso que "parou de pagar".
  const c = avaliarGatilhos(
    com({ severidadeChurnSilencioso: 'risco', faixaEngajamento: 'nulo', diasAtrasoMax: 0 }),
  ).find((x) => x.gatilho === 'G-07')!
  assert.match(c.motivo, /parou de usar/)
  assert.match(c.motivo, /em dia/)
})

test('a severidade define prazo e dono', () => {
  const dono = (sev: string) =>
    avaliarGatilhos(com({ severidadeChurnSilencioso: sev, faixaEngajamento: 'baixo' })).find(
      (x) => x.gatilho === 'G-07',
    )!
  assert.equal(dono('risco').donoPapel, 'csm')
  assert.equal(dono('critico').donoPapel, 'cs_lead')
  assert.ok(dono('critico').prazoDias < dono('risco').prazoDias)
})

test('conta com atraso não recebe item financeiro E de churn silencioso', () => {
  // Dois itens para um fato é como um time aprende a ignorar a fila. Com atraso
  // relevante, a família financeira é dona: mesma evidência, ação mais clara.
  const comAtraso = com({
    severidadeChurnSilencioso: 'pdd',
    faixaEngajamento: 'baixo',
    diasAtrasoMax: 132,
    valorAbertoCentavos: 1_753_100,
  })
  assert.deepEqual(ids(comAtraso), ['G-03'])
})

test('atraso pequeno demais para item financeiro não silencia o churn silencioso', () => {
  // Aos 12 dias nenhum gatilho financeiro dispara; se o G-07 também calasse, o
  // sinal sumiria justamente na faixa em que ninguém mais olha.
  const quaseEmDia = com({
    severidadeChurnSilencioso: 'risco',
    faixaEngajamento: 'nulo',
    diasAtrasoMax: 12,
  })
  assert.deepEqual(ids(quaseEmDia), ['G-07'])
})

test('o corte usa o mesmo limiar que abre o item financeiro', () => {
  // Se os dois números divergirem, volta a haver faixa com item duplicado ou
  // faixa sem item nenhum.
  const sev = { severidadeChurnSilencioso: 'risco' as const, faixaEngajamento: 'nulo' as const }
  assert.deepEqual(ids(com({ ...sev, diasAtrasoMax: ATRASO_ITEM_FINANCEIRO - 1 })), ['G-07'])
  assert.deepEqual(ids(com({ ...sev, diasAtrasoMax: ATRASO_ITEM_FINANCEIRO })), ['G-01'])
})

test('severidade saudável ou atenção não gera item de churn silencioso', () => {
  assert.equal(ids(com({ severidadeChurnSilencioso: 'saudavel' })).includes('G-07'), false)
  assert.equal(ids(com({ severidadeChurnSilencioso: 'atencao' })).includes('G-07'), false)
})

// ── Renovação ───────────────────────────────────────────────────────────────

test('a renovação abre 90 dias antes e o prazo é a própria janela', () => {
  assert.equal(ids(com({ diasParaVigenciaFim: 120 })).includes('G-09'), false)
  const c = avaliarGatilhos(com({ diasParaVigenciaFim: 80 })).find((x) => x.gatilho === 'G-09')!
  assert.match(c.motivo, /80 dias/)
  // Não há SLA configurável quando a data é dura.
  assert.equal(c.prazoDias, 50)
})

test('vigência já vencida não gera item de renovação', () => {
  assert.equal(ids(com({ diasParaVigenciaFim: -5 })).includes('G-09'), false)
})

// ── Fontes ausentes ─────────────────────────────────────────────────────────

test('gatilho sem fonte não dispara e não inventa valor', () => {
  // NPS, indisponibilidade, marcos e segmento ainda não têm fonte. O gatilho é
  // declarado e não avaliado — silêncio é a resposta certa, não um zero.
  const semFonte = ids(BASE)
  for (const g of ['G-10', 'G-11', 'G-12', 'G-13', 'G-14']) {
    assert.equal(semFonte.includes(g), false, `${g} disparou sem fonte`)
  }
})

test('com a fonte presente, os gatilhos declarados disparam', () => {
  assert.ok(ids(com({ nps: 4 })).includes('G-10'))
  assert.ok(ids(com({ horasIndisponibilidade: 6 })).includes('G-11'))
  assert.ok(ids(com({ marcosAtrasados: 2 })).includes('G-12'))
  assert.ok(ids(com({ segmentoMudou: true })).includes('G-14'))
})

test('expansão exige adesão bem acima do segmento, não só produto ausente', () => {
  // Palpite não vira oportunidade: o comercial recebe com evidência.
  assert.equal(ids(com({ produtosAusentes: ['Telemed'], adesao30d: 0.3 })).includes('G-13'), false)
  assert.ok(ids(com({ produtosAusentes: ['Telemed'], adesao30d: 0.6 })).includes('G-13'))
})

// ── Um por família ──────────────────────────────────────────────────────────

test('dois candidatos da mesma família viram um, e vence a prioridade', () => {
  const dois = [
    { gatilho: 'G-05', familia: 'adesao' as const, prioridade: 'media' as const, prazoDias: 10, motivo: 'a', evidencia: {}, donoPapel: 'csm' as const },
    { gatilho: 'G-04', familia: 'adesao' as const, prioridade: 'alta' as const, prazoDias: 5, motivo: 'b', evidencia: {}, donoPapel: 'csm' as const },
  ]
  const r = umPorFamilia(dois)
  assert.equal(r.length, 1)
  assert.equal(r[0]?.gatilho, 'G-04')
})

test('famílias diferentes convivem', () => {
  // Um cliente pode legitimamente ter um problema financeiro E um de adesão.
  const e = com({ diasAtrasoMax: 38, adesao30d: 0.32, adesao30dAnterior: 0.41 })
  const familias = umPorFamilia(avaliarGatilhos(e)).map((c) => c.familia)
  assert.ok(familias.includes('financeiro'))
  assert.ok(familias.includes('adesao'))
})

// ── Estrutura ───────────────────────────────────────────────────────────────

test('os catorze gatilhos estão declarados, com propósito', () => {
  assert.equal(GATILHOS.length, 14)
  for (const g of GATILHOS) {
    assert.match(g.id, /^G-\d{2}$/)
    assert.ok(g.proposito.length > 20, `${g.id} sem propósito escrito`)
  }
})

test('todo candidato sai com motivo em linguagem natural, com número', () => {
  const casos = [
    com({ diasAtrasoMax: 38, valorAbertoCentavos: 500000 }),
    com({ adesao30d: 0.3, adesao30dAnterior: 0.45 }),
    com({ diasSemContato: 90 }),
    com({ diasParaVigenciaFim: 45 }),
  ]
  for (const e of casos) {
    for (const c of avaliarGatilhos(e)) {
      assert.ok(c.motivo.length > 10, `${c.gatilho}: motivo curto demais`)
      assert.match(c.motivo, /\d/, `${c.gatilho}: motivo sem número — "score caiu" não serve`)
      assert.equal(c.motivo, c.motivo.toLowerCase().slice(0, 1) + c.motivo.slice(1))
    }
  }
})
