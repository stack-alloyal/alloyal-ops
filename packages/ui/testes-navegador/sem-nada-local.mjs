/**
 * Prova que o kickoff é 100% banco: nada de dado no navegador.
 *
 * Os pontos que importam, e o motivo de cada um:
 *  · nenhuma chave de dado é escrita em `localStorage` — nem rascunho, nem sombra;
 *  · a área em nome de quem se registra vem do BANCO e atravessa navegadores;
 *  · quando a API falha, o formulário NÃO limpa e nada entra na tela — é isto que
 *    substitui o rascunho local como proteção do que a pessoa digitou;
 *  · o que ficou preso em navegador antigo é drenado para o banco e a chave é apagada;
 *  · inativar tira da tela e mantém a linha no banco.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE
const SEGREDO = process.env.PULSE_PROXY_SECRET

async function abrir(browser, email) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-pulse-proxy-secret': SEGREDO, 'x-auth-request-email': email },
  })
  // A CSP manda `upgrade-insecure-requests`, e está certa: em produção nada trafega em
  // claro. Falando http com o contêiner, o Chromium promove tudo para https e falha —
  // artefato do teste. A intercepção devolve ao http sem tocar na CSP servida.
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

const PRESO = {
  dores: [{
    id: 'antigo1', time: 'juridico',
    dor: 'Retenção de dado pessoal sem política escrita',
    impacto: 'Risco jurídico ou LGPD', frequencia: 'Esporádico, mas grave',
    sistema: 'Não existe em lugar nenhum', contorno: '',
  }],
  dados: [], planilhas: [], metricas: [], jornadas: [], automacoes: [], roadmap: [],
}

const CHAVES_DE_DADO = ['squad_dados_rascunho_v2', 'squad_dados_sombra_v1', 'squad_dados_meu_time']

const browser = await chromium.launch()
let falhas = 0
const ok = (c, m) => { console.log(`   ${c ? 'ok  ' : 'FALHA'} ${m}`); if (!c) falhas++ }

try {
  // ── 1. a área atravessa navegadores porque está no banco ──────────────────
  const ctxA = await abrir(browser, 'teste@alloyal.com.br')
  const pA = await ctxA.newPage()
  const erros = []
  pA.on('pageerror', (e) => erros.push(e.message))
  await pA.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  ok(erros.length === 0, `sem erro de JS${erros.length ? ': ' + erros[0] : ''}`)

  await pA.selectOption('#teamSel', 'operacoes')
  await pA.waitForTimeout(900)

  // Navegador NOVO, sem nada guardado: se a área aparecer, veio do banco.
  const ctxB = await abrir(browser, 'teste@alloyal.com.br')
  const pB = await ctxB.newPage()
  await pB.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  await pB.waitForTimeout(1200)
  const areaEmB = await pB.evaluate(() => document.getElementById('teamSel').value)
  ok(areaEmB === 'operacoes', `a área veio do banco num navegador limpo (viu "${areaEmB}")`)

  // ── 2. nenhuma chave de DADO é escrita ────────────────────────────────────
  const chaves = await pB.evaluate((ks) => {
    const escritas = ks.filter((k) => window.localStorage.getItem(k) !== null)
    return { escritas, total: window.localStorage.length }
  }, CHAVES_DE_DADO)
  ok(chaves.escritas.length === 0,
    `nenhuma chave de dado no navegador (achou: ${chaves.escritas.join(', ') || 'nenhuma'})`)
  ok(chaves.total === 0, `localStorage inteiro está vazio (${chaves.total} chave(s))`)

  // ── 3. API fora: o formulário NÃO limpa e nada entra na tela ──────────────
  await pB.route(`**/api/kickoff`, (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue())
  await pB.getByRole('button', { name: /Dores/ }).first().click()
  await pB.waitForSelector('#d-dor', { state: 'visible' })
  const TEXTO = 'esta frase não pode se perder quando a API cai'
  await pB.fill('#d-dor', TEXTO)
  await pB.fill('#d-contorno', 'contorno que também precisa sobreviver')
  const antes = await pB.evaluate(() => document.querySelectorAll('#rec-dores .rec').length)
  await pB.click('[data-add="dores"]')
  await pB.waitForTimeout(1200)
  const comApiFora = await pB.evaluate(() => ({
    campo: document.getElementById('d-dor').value,
    contorno: document.getElementById('d-contorno').value,
    naTela: document.querySelectorAll('#rec-dores .rec').length,
    status: document.getElementById('d-status').textContent,
    botaoLiberado: !document.querySelector('[data-add="dores"]').disabled,
  }))
  ok(comApiFora.campo === TEXTO, 'o texto digitado continua no campo depois da falha')
  ok(comApiFora.contorno !== '', 'os outros campos também continuam preenchidos')
  ok(comApiFora.naTela === antes, `nada entrou na tela (${antes} → ${comApiFora.naTela})`)
  ok(/NÃO salvou/.test(comApiFora.status || ''), `o erro é dito ("${comApiFora.status}")`)
  ok(comApiFora.botaoLiberado, 'o botão volta a funcionar para a pessoa tentar de novo')

  const nadaLocal = await pB.evaluate(() => window.localStorage.length)
  ok(nadaLocal === 0, `mesmo com a API fora, nada foi guardado local (${nadaLocal} chave(s))`)

  // API de volta: o mesmo clique agora salva e limpa.
  await pB.unroute(`**/api/kickoff`)
  await pB.click('[data-add="dores"]')
  await pB.waitForFunction(
    (n) => document.querySelectorAll('#rec-dores .rec').length > n, antes, { timeout: 20000 })
  const depois = await pB.evaluate(() => ({
    campo: document.getElementById('d-dor').value,
    status: document.getElementById('d-status').textContent,
  }))
  ok(depois.campo === '', 'com a API de volta, o campo limpa — e só então')
  ok(/Salvo no banco/.test(depois.status || ''), `o status confirma o banco ("${depois.status}")`)

  // ── 4. drenar navegador antigo: envia e APAGA a chave ─────────────────────
  const ctxC = await abrir(browser, 'ruben.dias@alloyal.com.br')
  await ctxC.addInitScript(([k, v]) => { window.localStorage.setItem(k, v) },
    ['squad_dados_registros_v1', JSON.stringify(PRESO)])
  const pC = await ctxC.newPage()
  await pC.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  const drenou = await pC.waitForFunction(
    () => Array.from(document.querySelectorAll('#cons-dores .rec-title'))
      .some((n) => /Retenção de dado pessoal sem política/.test(n.textContent)),
    null, { timeout: 25000 }).then(() => true).catch(() => false)
  ok(drenou, 'o registro preso no navegador antigo chegou ao banco')
  const chaveSumiu = await pC.waitForFunction(
    () => window.localStorage.getItem('squad_dados_registros_v1') === null,
    null, { timeout: 15000 }).then(() => true).catch(() => false)
  ok(chaveSumiu, 'a chave antiga foi APAGADA — o navegador não guarda mais nada')

  // F5 não duplica: o conteúdo já está no banco e a chave não existe mais.
  await pC.reload({ waitUntil: 'networkidle' })
  await pC.waitForTimeout(1500)
  const quantos = await pC.evaluate(() => Array.from(document.querySelectorAll('#cons-dores .rec-title'))
    .filter((n) => /Retenção de dado pessoal sem política/.test(n.textContent)).length)
  ok(quantos === 1, `depois do F5 continua 1, sem duplicar (viu ${quantos})`)

  // ── 5. inativar tira da tela e mantém no banco ───────────────────────────
  const idParaInativar = await pC.evaluate(async () => {
    const d = await (await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })).json()
    return (d.dores.find((r) => /Retenção de dado pessoal/.test(r.dor)) || {}).id
  })
  const inativou = await pC.evaluate(async (id) => {
    const r = await fetch('/api/kickoff?id=' + id, { method: 'DELETE' })
    return r.status
  }, idParaInativar)
  ok(inativou === 200, `o autor inativa o próprio registro (HTTP ${inativou})`)
  const foraDaTela = await pC.evaluate(async () => {
    const d = await (await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })).json()
    return d.dores.some((r) => /Retenção de dado pessoal/.test(r.dor))
  })
  ok(!foraDaTela, 'inativado não volta na leitura')
  console.log(`   id inativado (confira no banco que a linha ficou): ${idParaInativar}`)

  // ── 6. o que o teste da mecânica antiga cobria e continua valendo ─────────
  // Autoria em todo cartão, botão de remover só onde funciona, 404 para quem não é
  // autor, e a recarga automática levando o registro de uma área para a outra.
  const ctxD = await abrir(browser, 'mariana.freitas@alloyal.com.br')
  const pD = await ctxD.newPage()
  await pD.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  await pD.waitForTimeout(1200)

  const vistoPorD = await pD.evaluate(async () => {
    const d = await (await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })).json()
    const cartoes = document.querySelectorAll('#cons-dores .rec').length
    return {
      podeApagarTudo: d.podeApagarTudo,
      cartoes,
      autorias: Array.from(document.querySelectorAll('#cons-dores .rec-meta'))
        .filter((n) => /^por /.test(n.textContent)).length,
      remover: document.querySelectorAll('#cons-dores [data-del]').length,
      dores: d.dores.length,
    }
  })
  ok(vistoPorD.podeApagarTudo === false, 'quem não administra recebe podeApagarTudo=false')
  ok(vistoPorD.cartoes === vistoPorD.dores,
    `outra pessoa vê TODAS as dores do banco (${vistoPorD.cartoes}/${vistoPorD.dores})`)
  ok(vistoPorD.autorias === vistoPorD.cartoes,
    `autoria em todo cartão (${vistoPorD.autorias}/${vistoPorD.cartoes})`)
  ok(vistoPorD.remover === 0,
    `sem botão remover em registro de outra pessoa (viu ${vistoPorD.remover})`)

  const naoAutor = await pD.evaluate(async () => {
    const d = await (await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })).json()
    const alheio = d.dores.find((r) => r.autor !== d.eu)
    if (!alheio) return 'sem registro alheio para testar'
    return (await fetch('/api/kickoff?id=' + alheio.id, { method: 'DELETE' })).status
  })
  ok(naoAutor === 404, `quem não é autor nem admin recebe 404 ao tentar remover (${naoAutor})`)

  // Recarga automática: pB registra e pD vê sem recarregar.
  const antesEmD = await pD.evaluate(() => document.querySelectorAll('#cons-dores .rec').length)
  await pB.evaluate(async () => {
    await fetch('/api/kickoff', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'dores', time: 'operacoes', dados: {
        dor: 'registro para provar a recarga automática', impacto: 'Tempo operacional',
        frequencia: 'Diariamente', sistema: 'Pulse', contorno: '' } }),
    })
  })
  const chegouSozinho = await pD.waitForFunction(
    (n) => document.querySelectorAll('#cons-dores .rec').length > n, antesEmD, { timeout: 30000 })
    .then(() => true).catch(() => false)
  ok(chegouSozinho, 'registro de outra área aparece sem recarregar (recarga automática)')
} finally {
  await browser.close()
}

console.log(falhas === 0 ? '\n   TODOS OS PONTOS PASSARAM' : `\n   ${falhas} FALHA(S)`)
process.exit(falhas === 0 ? 0 : 1)
