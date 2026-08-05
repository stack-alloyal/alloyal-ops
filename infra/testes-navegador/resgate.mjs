/**
 * Prova o resgate no navegador: semeia a chave ANTIGA do localStorage, abre o
 * documento e confere que os registros sobem para o depósito comum e que outra
 * pessoa os vê.
 *
 * Roda contra o container direto, com os cabeçalhos que o porteiro injetaria.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE
const SEGREDO = process.env.PULSE_PROXY_SECRET

// O que "Operações" teria digitado na versão anterior, guardado só no navegador.
const ANTIGO = {
  dores: [
    {
      id: 'k9x2a',
      time: 'operacoes',
      dor: 'Fechamento de CS depende de planilha colada à mão',
      impacto: 'Receita — risco de churn',
      frequencia: 'Toda semana',
      sistema: 'Pulse',
      contorno: 'Exporta do Lecupon e cola na planilha do time',
    },
    {
      id: 'k9x2b',
      time: 'operacoes',
      dor: 'Não há visão de quais clientes ficaram sem uso no mês',
      impacto: 'Operacional',
      frequencia: 'Todo mês',
      sistema: 'Pulse',
      contorno: '',
    },
  ],
  planilhas: [
    {
      id: 'k9x2c',
      time: 'operacoes',
      nome: 'Controle de ativação — CS',
      dono: 'Operações',
      controla: 'Ativação por cliente',
      origem: 'Export do Lecupon',
      frequencia: 'Semanal',
      horas: '6',
      quebra: 'O time perde a fila de contato da semana',
      lgpd: true,
      link: 'https://docs.google.com/spreadsheets/d/exemplo',
    },
  ],
  dados: [], metricas: [], jornadas: [], automacoes: [],
}

/**
 * A CSP da aplicação traz `upgrade-insecure-requests`, e está certa: em produção nada
 * deve trafegar em claro. Aqui o teste fala com o container em http, então o navegador
 * promove tudo para https e bate em ERR_SSL_PROTOCOL_ERROR — artefato do teste, não
 * defeito. A intercepção devolve a requisição ao http, sem tocar na CSP servida.
 */
async function abrir(browser, email) {
  const ctx = await browser.newContext({
    extraHTTPHeaders: {
      'x-pulse-proxy-secret': SEGREDO,
      'x-auth-request-email': email,
    },
  })
  const alvo = BASE.replace('http://', 'https://')
  await ctx.route(`${alvo}/**`, async (route) => {
    const req = route.request()
    const r = await ctx.request.fetch(req.url().replace('https://', 'http://'), {
      method: req.method(),
      headers: req.headers(),
      ...(req.postData() === null ? {} : { data: req.postData() }),
      maxRedirects: 0,
    })
    await route.fulfill({ response: r })
  })
  return ctx
}

/** O documento é um deck de slides: o Consolidado começa oculto, e botão oculto não
 *  recebe clique. Navega pela trilha lateral, como uma pessoa faria. */
async function irParaConsolidado(page) {
  await page.getByRole('button', { name: /Consolidado/ }).first().click()
  await page.waitForSelector('#rescueBtn', { state: 'visible' })
}

const browser = await chromium.launch()
let falhas = 0
const ok = (cond, msg) => { console.log(`   ${cond ? 'ok  ' : 'FALHA'} ${msg}`); if (!cond) falhas++ }

try {
  // ── 0. LINHA DE BASE pela API, ANTES de qualquer página abrir ─────────────
  // A produção tem dado real e este teste NÃO limpa a base — mede a diferença. Medir
  // dentro da página já aberta não serve: o resgate roda na carga, e a base sairia
  // contaminada pelos próprios registros do teste.
  const ctxBase = await abrir(browser, 'teste@alloyal.com.br')
  const inicial = await (await ctxBase.request.get(`${BASE}/api/kickoff`)).json()
  const base = { dores: inicial.dores.length, planilhas: inicial.planilhas.length }
  await ctxBase.close()
  console.log(`   base pela API: dores=${base.dores} planilhas=${base.planilhas}`)

  // ── 1. Operações abre o doc com a chave ANTIGA semeada ────────────────────
  const ctxOps = await abrir(browser, 'teste@alloyal.com.br')
  await ctxOps.addInitScript(
    ([chave, valor]) => { window.localStorage.setItem(chave, valor) },
    ['squad_dados_registros_v1', JSON.stringify(ANTIGO)],
  )
  const pOps = await ctxOps.newPage()
  const erros = []
  pOps.on('pageerror', (e) => erros.push(e.message))
  await pOps.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })

  ok(erros.length === 0, `documento sem erro de JS${erros.length ? ': ' + erros[0] : ''}`)


  // O resgate é assíncrono e em série: espera o depósito encher.
  await pOps.waitForFunction(
    (n) => document.querySelectorAll('#cons-dores .rec').length >= n + 2,
    base.dores,
    { timeout: 20000 },
  ).catch(() => {})

  const naTela = await pOps.evaluate(() => ({
    dores: document.querySelectorAll('#cons-dores .rec').length,
    planilhas: document.querySelectorAll('#cons-planilhas .rec').length,
    status: (document.getElementById('storeStatus') || {}).textContent || '',
    marca: window.localStorage.getItem('squad_dados_resgatado_v2'),
    antigaVazia: (() => {
      const b = window.localStorage.getItem('squad_dados_registros_v1')
      if (!b) return true
      const o = JSON.parse(b)
      return Object.keys(o).every((k) => !Array.isArray(o[k]) || o[k].length === 0)
    })(),
  }))
  ok(naTela.dores === base.dores + 2, `+2 dores na tela (${base.dores} → ${naTela.dores})`)
  ok(naTela.planilhas === base.planilhas + 1, `+1 planilha na tela (${base.planilhas} → ${naTela.planilhas})`)
  ok(naTela.marca === '1', 'chave antiga marcada como resgatada')
  ok(naTela.antigaVazia, 'chave antiga esvaziada (registro riscado ao chegar)')
  console.log(`   status: ${naTela.status}`)

  // ── 2. RECARREGAR não duplica ─────────────────────────────────────────────
  await pOps.reload({ waitUntil: 'networkidle' })
  await pOps.waitForTimeout(1500)
  const depois = await pOps.evaluate(() => document.querySelectorAll('#cons-dores .rec').length)
  ok(depois === base.dores + 2, `depois do F5 não duplica (viu ${depois})`)

  // ── 3. OUTRA pessoa, de outra área, vê o que Operações registrou ──────────
  const ctxOutro = await abrir(browser, 'ruben.dias@alloyal.com.br')
  const pOutro = await ctxOutro.newPage()
  await pOutro.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  await pOutro.waitForTimeout(1500)
  const visto = await pOutro.evaluate(() => ({
    dores: document.querySelectorAll('#cons-dores .rec').length,
    planilhas: document.querySelectorAll('#cons-planilhas .rec').length,
    autores: Array.from(document.querySelectorAll('#cons-dores .rec-meta'))
      .map((n) => n.textContent).filter((t) => t.startsWith('por ')),
    remover: document.querySelectorAll('#cons-dores [data-del]').length,
    marca: window.localStorage.getItem('squad_dados_resgatado_v2'),
  }))
  ok(visto.dores === base.dores + 2, `outra pessoa vê as dores (viu ${visto.dores})`)
  ok(visto.planilhas === base.planilhas + 1, `outra pessoa vê a planilha (viu ${visto.planilhas})`)
  ok(visto.autores.length === visto.dores, `autoria em TODO cartão (${visto.autores.length}/${visto.dores})`)
  ok(visto.remover === 0, `sem botão "remover" no registro de outra pessoa (viu ${visto.remover})`)
  // Navegador sem nada a resgatar recebe a marca de propósito: sem ela, a chave
  // antiga seria aberta e analisada em toda carga, para sempre.
  ok(visto.marca === '1', 'navegador sem nada a resgatar é marcado, e não reabre a chave antiga')

  // ── 4. Recarga automática: registro novo aparece SEM F5 ───────────────────
  const antes = await pOutro.evaluate(() => document.querySelectorAll('#cons-dados .rec').length)
  await pOps.evaluate(async () => {
    await fetch('/api/kickoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'dados', time: 'operacoes',
        dados: { campo: 'Data da última compra por cliente', criticidade: 'Essencial — decide contato', fonte: 'Lecupon', uso: 'Fila de reativação' },
      }),
    })
  })
  const apareceu = await pOutro
    .waitForFunction((n) => document.querySelectorAll('#cons-dados .rec').length > n, antes, { timeout: 30000 })
    .then(() => true).catch(() => false)
  ok(apareceu, 'registro novo aparece na aba da outra pessoa sem recarregar (recarga automática)')

  // ── 5. Quem administra remove qualquer um; o dono do registro também ──────
  const status = await pOutro.evaluate(async () => {
    const r = await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })
    const d = await r.json()
    const id = d.dores[0].id
    const del = await fetch('/api/kickoff?id=' + id, { method: 'DELETE' })
    return { podeApagarTudo: d.podeApagarTudo, del: del.status }
  })
  ok(status.podeApagarTudo === false, 'quem não administra recebe podeApagarTudo=false')
  ok(status.del === 404, `remoção por quem não é autor nem admin → 404 (viu ${status.del})`)
  // ── 6. O BOTÃO: navegador JÁ MARCADO, com dado ainda preso ────────────────
  // O caso perigoso: a marca foi gravada mas os registros não subiram. Sem o botão,
  // o resgate automático nunca mais olharia essa chave.
  const ctxPreso = await abrir(browser, 'ruben.dias@alloyal.com.br')
  await ctxPreso.addInitScript(
    ([k1, v1, k2]) => {
      window.localStorage.setItem(k1, v1)
      window.localStorage.setItem(k2, '1')     // marcado ANTES de subir: o dado ficaria preso
    },
    ['squad_dados_registros_v1', JSON.stringify({
      ...ANTIGO, dores: [{ id: 'presoA', time: 'financeiro', dor: 'Conciliação de repasse feita à mão', impacto: 'Financeiro', frequencia: 'Todo mês', sistema: 'Pulse', contorno: '' }],
      planilhas: [],
    }), 'squad_dados_resgatado_v2'],
  )
  const pPreso = await ctxPreso.newPage()
  await pPreso.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  await pPreso.waitForTimeout(1200)

  // Mede o REGISTRO, não a contagem: o depósito já tem os dos passos anteriores, e
  // contar cartões aqui confunde "resgatou" com "já estava lá".
  const conta = () => pPreso.evaluate(
    () => Array.from(document.querySelectorAll('#cons-dores .rec-title'))
      .filter((n) => /Concilia\u00e7\u00e3o de repasse/.test(n.textContent)).length,
  )
  ok((await conta()) === 0, 'com a marca gravada, o automático NÃO resgata')

  await irParaConsolidado(pPreso)
  await pPreso.click('#rescueBtn')
  const resgatou = await pPreso
    .waitForFunction(
      () => Array.from(document.querySelectorAll('#cons-dores .rec-title'))
        .some((n) => /Concilia\u00e7\u00e3o de repasse/.test(n.textContent)),
      null, { timeout: 25000 },
    ).then(() => true).catch(() => false)
  ok(resgatou, 'o botão "Recuperar deste navegador" desprende o registro preso')

  // Espera a chave esvaziar: o envio é assíncrono, e ler agora mesmo é corrida.
  const vazioDepois = await pPreso.waitForFunction(() => {
    const b = window.localStorage.getItem('squad_dados_registros_v1')
    if (!b) return true
    const o = JSON.parse(b)
    return Object.keys(o).every((k) => !Array.isArray(o[k]) || o[k].length === 0)
  }, null, { timeout: 15000 }).then(() => true).catch(() => false)
  ok(vazioDepois, 'chave antiga esvaziada depois do botão')

  // Apertar de novo não duplica e diz que não há mais nada.
  await pPreso.click('#rescueBtn')
  await pPreso.waitForTimeout(3000)
  ok((await conta()) === 1, `apertar de novo não duplica (viu ${await conta()})`)
  const aviso = await pPreso.evaluate(() => (document.getElementById('toast') || {}).textContent || '')
  ok(/Nada guardado/.test(aviso), `avisa que nada ficou preso ("${aviso}")`)

} finally {
  await browser.close()
}

console.log(falhas === 0 ? '\n   TODOS OS PONTOS PASSARAM' : `\n   ${falhas} FALHA(S)`)
process.exit(falhas === 0 ? 0 : 1)
