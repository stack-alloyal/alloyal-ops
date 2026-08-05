/** Prova o Roadmap: ordem do menu, cadastro de tarefa, timeline e visão por área. */
import { chromium } from 'playwright'

const BASE = process.env.BASE
const SEGREDO = process.env.PULSE_PROXY_SECRET

async function abrir(browser, email) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-pulse-proxy-secret': SEGREDO, 'x-auth-request-email': email },
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

const ESPERADO = [
  'Capa', 'Fonte de Verdade', 'Alloyal Pulse', 'Centralização', 'Dores',
  'Dados a Coletar', 'Planilhas', 'Automações', 'Métricas por time', 'Jornadas',
  'Consolidado', 'Roadmap',
]

const TAREFAS = [
  { area: 'financeiro', titulo: 'Dicionário de métricas de churn', resp: 'Mariana (Financeiro)',
    inicio: '2026-08-10', fim: '2026-09-15', status: 'Em andamento', desc: 'Uma definição por termo, para toda a empresa.' },
  { area: 'comercial', titulo: 'Aprovar a fonte da verdade por domínio', resp: 'Gabriel (Comercial)',
    inicio: '2026-08-06', fim: '2026-08-20', status: 'Não iniciada', desc: '' },
  { area: 'operacoes', titulo: 'Nomear dono de dado por domínio', resp: 'Luís (CS)',
    inicio: '2026-09-01', fim: '2026-11-28', status: 'Bloqueada', desc: 'Depende da decisão 1.' },
  // Sem datas de propósito: precisa aparecer à parte, e não ganhar barra inventada.
  { area: 'juridico', titulo: 'Revisar retenção de dado pessoal', resp: '', inicio: '', fim: '', status: 'Não iniciada', desc: '' },
]

const browser = await chromium.launch()
let falhas = 0
const ok = (c, m) => { console.log(`   ${c ? 'ok  ' : 'FALHA'} ${m}`); if (!c) falhas++ }

try {
  const ctx = await abrir(browser, 'teste@alloyal.com.br')
  const p = await ctx.newPage()
  const erros = []
  p.on('pageerror', (e) => erros.push(e.message))
  await p.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  ok(erros.length === 0, `sem erro de JS${erros.length ? ': ' + erros[0] : ''}`)

  // ── 1. a ordem do menu ────────────────────────────────────────────────────
  const menu = await p.$$eval('.rail-item', (ns) =>
    ns.map((n) => n.textContent.replace(/^\d+/, '').trim()))
  ok(JSON.stringify(menu) === JSON.stringify(ESPERADO),
    `ordem do menu\n        esperado: ${ESPERADO.join(' · ')}\n        obtido:   ${menu.join(' · ')}`)

  // ── 2. a etiqueta numerada de cada slide bate com a posição ───────────────
  const etiquetas = await p.$$eval('.slide .eyebrow', (ns) => ns.map((n) => n.textContent.trim()))
  ok(/^10 · Roadmap$/.test(etiquetas[11] || ''), `etiqueta do Roadmap: "${etiquetas[11]}"`)
  ok(/^01 · Fonte da verdade$/.test(etiquetas[1] || ''), `etiqueta da 2ª slide: "${etiquetas[1]}"`)

  // ── 3. cadastro das tarefas ───────────────────────────────────────────────
  // LINHA DE BASE antes de inserir: a produção tem dado REAL do time, e o teste não
  // limpa a base — mede a diferença. Foi limpar a base que destruiu 17 registros
  // de Operações em 05/08/2026.
  const base = await p.evaluate(async () => {
    const r = await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })
    const d = await r.json()
    return {
      roadmap: d.roadmap.length,
      barras: document.querySelectorAll('#rmp-timeline .tl-barra').length,
      cartoes: document.querySelectorAll('#rmp-por-area .rec').length,
      grupos: document.querySelectorAll('#rmp-por-area .rmp-grupo h4').length,
    }
  })
  console.log(`   base: roadmap=${base.roadmap} barras=${base.barras} cartões=${base.cartoes}`)

  await p.getByRole('button', { name: /Roadmap/ }).first().click()
  await p.waitForSelector('#r-titulo', { state: 'visible' })
  await p.selectOption('#teamSel', 'operacoes')

  for (const t of TAREFAS) {
    await p.selectOption('#r-area', t.area)
    await p.fill('#r-titulo', t.titulo)
    await p.fill('#r-resp', t.resp)
    await p.fill('#r-desc', t.desc)
    if (t.inicio) await p.fill('#r-inicio', t.inicio)
    if (t.fim) await p.fill('#r-fim', t.fim)
    await p.selectOption('#r-status', t.status)
    await p.click('[data-add="roadmap"]')
    await p.waitForTimeout(700)
  }

  const noBanco = await p.evaluate(async () => {
    const r = await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })
    return (await r.json()).roadmap.length
  })
  ok(noBanco === base.roadmap + 4, `as 4 tarefas chegaram ao banco (${base.roadmap} → ${noBanco})`)

  // ── 4. a data de fim antes do início é recusada ───────────────────────────
  await p.selectOption('#r-area', 'comercial')
  await p.fill('#r-titulo', 'Tarefa com prazo invertido')
  await p.fill('#r-inicio', '2026-10-10')
  await p.fill('#r-fim', '2026-09-01')
  await p.click('[data-add="roadmap"]')
  await p.waitForTimeout(400)
  const msg = await p.textContent('#r-status-msg')
  ok(/não pode ser anterior/.test(msg || ''), `prazo invertido recusado ("${msg}")`)
  const aindaQuatro = await p.evaluate(async () => {
    const r = await fetch('/api/kickoff', { headers: { Accept: 'application/json' } })
    return (await r.json()).roadmap.length
  })
  ok(aindaQuatro === base.roadmap + 4, `a tarefa recusada não foi gravada (banco tem ${aindaQuatro})`)
  await p.fill('#r-fim', '2026-11-01')   // corrige para não deixar campo sujo

  // ── 5. a timeline ─────────────────────────────────────────────────────────
  const tl = await p.evaluate(() => {
    const barras = Array.from(document.querySelectorAll('#rmp-timeline .tl-barra'))
    return {
      barras: barras.length,
      classes: barras.map((b) => b.className.replace('tl-barra ', '')),
      esquerdas: barras.map((b) => parseFloat(b.style.left)),
      larguras: barras.map((b) => parseFloat(b.style.width)),
      meses: Array.from(document.querySelectorAll('#rmp-timeline .tl-mes')).map((n) => n.textContent.trim()),
      semData: (document.querySelector('#rmp-timeline .tl-semdata') || {}).textContent || '',
    }
  })
  ok(tl.barras === base.barras + 3, `+3 barras na timeline — a sem data não ganha barra (${base.barras} → ${tl.barras})`)
  ok(/Revisar retenção/.test(tl.semData) && /1 tarefa sem data/.test(tl.semData),
    `a tarefa sem data é dita à parte ("${tl.semData.trim().slice(0, 80)}…")`)
  ok(tl.esquerdas[0] === 0, `a barra mais antiga começa em 0% (viu ${tl.esquerdas[0]}%)`)
  ok(tl.esquerdas.every((e, i) => i === 0 || e >= tl.esquerdas[i - 1]),
    `barras ordenadas por início (${tl.esquerdas.map((e) => e.toFixed(1)).join(' → ')})`)
  ok(tl.esquerdas.every((e, i) => e + tl.larguras[i] <= 100.01),
    'nenhuma barra passa de 100% da pista')
  ok(tl.meses.length >= 4 && /^ago/.test(tl.meses[0]) && tl.meses[tl.meses.length-1] === 'nov',
    `régua de meses: ${tl.meses.join(' · ')}`)
  ok(tl.classes.includes('andamento') && tl.classes.includes('bloqueada'),
    `status colorem a barra (${tl.classes.join(', ')})`)

  // A etiqueta de mês precisa alinhar com a barra: setembro começa em 01/09, e a
  // tarefa de Operações começa no mesmo dia — as duas posições têm de coincidir.
  const alinha = await p.evaluate(() => {
    const set = Array.from(document.querySelectorAll('#rmp-timeline .tl-mes'))
      .find((n) => n.textContent.trim().startsWith('set'))
    const barraOps = Array.from(document.querySelectorAll('#rmp-timeline .tl-linha'))
      .find((l) => /Nomear dono/.test(l.textContent))
      .querySelector('.tl-barra')
    return { mes: parseFloat(set.style.left), barra: parseFloat(barraOps.style.left) }
  })
  ok(Math.abs(alinha.mes - alinha.barra) < 0.6,
    `etiqueta de set (${alinha.mes.toFixed(2)}%) alinha com a barra de 01/09 (${alinha.barra.toFixed(2)}%)`)

  // ── 6. a aba "Por área" ───────────────────────────────────────────────────
  await p.getByRole('tab', { name: 'Por área' }).click()
  await p.waitForTimeout(300)
  const pa = await p.evaluate(() => ({
    visivel: !!document.querySelector('#rmp-area.on'),
    grupos: Array.from(document.querySelectorAll('#rmp-por-area .rmp-grupo h4')).map((n) => n.textContent.trim()),
    cartoes: document.querySelectorAll('#rmp-por-area .rec').length,
    responsaveis: Array.from(document.querySelectorAll('#rmp-por-area .rec-meta'))
      .map((n) => n.textContent).filter((t) => /Responsável|Sem responsável/.test(t)).length,
  }))
  ok(pa.visivel, 'a aba "Por área" aparece ao clicar')
  ok(pa.cartoes === base.cartoes + 4, `+4 tarefas na visão por área (${base.cartoes} → ${pa.cartoes})`)
  ok(pa.grupos.length >= 4, `um grupo por área, na ordem: ${pa.grupos.join(' | ')}`)
  ok(/^Comercial/.test(pa.grupos[0]) && /^Financeiro/.test(pa.grupos[1]),
    `ordem fixa das áreas (1º "${pa.grupos[0]}", 2º "${pa.grupos[1]}")`)
  ok(pa.responsaveis === pa.cartoes, `responsável dito em TODO cartão, inclusive quando falta (${pa.responsaveis}/${pa.cartoes})`)

  // ── 7. outra pessoa vê o roadmap inteiro ──────────────────────────────────
  const ctx2 = await abrir(browser, 'ruben.dias@alloyal.com.br')
  const p2 = await ctx2.newPage()
  await p2.goto(`${BASE}/docs/kickoff.html`, { waitUntil: 'networkidle' })
  await p2.waitForTimeout(1500)
  const outra = await p2.evaluate(() => ({
    barras: document.querySelectorAll('#rmp-timeline .tl-barra').length,
    cartoes: document.querySelectorAll('#rmp-por-area .rec').length,
    remover: document.querySelectorAll('#rmp-por-area [data-del="roadmap"]').length,
  }))
  ok(outra.barras === base.barras + 3, `outra pessoa vê a timeline (${outra.barras} barras)`)
  ok(outra.cartoes === base.cartoes + 4, `outra pessoa vê as tarefas (viu ${outra.cartoes})`)
  ok(outra.remover === 0, `sem botão remover em tarefa de outra pessoa (viu ${outra.remover})`)

  // ── 8. o Markdown exportado traz o Roadmap ────────────────────────────────
  const md = await p.evaluate(() => {
    // Reaproveita o próprio construtor do documento interceptando o download.
    let capturado = ''
    const orig = URL.createObjectURL
    URL.createObjectURL = (b) => { capturado = b; return 'blob:x' }
    document.getElementById('expMd').click()
    URL.createObjectURL = orig
    return capturado ? capturado.text() : ''
  })
  ok(/## Roadmap/.test(md), 'a exportação Markdown tem a seção Roadmap')
  ok(/Dicionário de métricas de churn/.test(md) && /Mariana \(Financeiro\)/.test(md),
    'a tabela do Markdown traz tarefa e responsável')
  ok(/### Descrição das tarefas/.test(md), 'as descrições saem fora da tabela')

  // O exportar abre o diálogo de cópia — modal aberto intercepta todo clique seguinte.
  await p.keyboard.press('Escape')
  await p.waitForSelector('#overlay.on', { state: 'hidden' })

  await p.getByRole('tab', { name: 'Timeline' }).click()
  await p.waitForTimeout(400)
  await p.screenshot({ path: '/home/ubuntu/alloyal-pulse/roadmap-timeline.png' })
  await p.getByRole('tab', { name: 'Por área' }).click()
  await p.waitForTimeout(400)
  await p.screenshot({ path: '/home/ubuntu/alloyal-pulse/roadmap-areas.png' })
} finally {
  await browser.close()
}

console.log(falhas === 0 ? '\n   TODOS OS PONTOS PASSARAM' : `\n   ${falhas} FALHA(S)`)
process.exit(falhas === 0 ? 0 : 1)
