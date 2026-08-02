/**
 * Gera os ícones do Pulse a partir do SVG, e embute o favicon na tela de entrada.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE UM GERADOR, E NÃO PNG COMMITADO NA MÃO:                            │
 * │                                                                            │
 * │ São seis arquivos saídos de uma arte só. Ajustar o desenho e reexportar    │
 * │ cinco deles à mão é como as versões divergem — e ícone divergente não dá   │
 * │ erro, só fica esquisito num tamanho que ninguém olha.                      │
 * │                                                                            │
 * │ Os PNG CONTINUAM versionados: o build da imagem não roda navegador, e      │
 * │ baixar 111MB de Chromium num Dockerfile para desenhar um favicon seria     │
 * │ pior que o problema. Este script é para quando a ARTE mudar.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A renderização usa o Chromium do Playwright porque é o mesmo motor que vai
 * exibir o SVG no navegador — `rsvg`/ImageMagick divergem em `stroke-linejoin`
 * e no gradiente, e a diferença aparece justamente nos tamanhos pequenos.
 *
 * Uso:  node packages/ui/marca/gerar.mjs
 *       (precisa de `npx playwright install chromium` uma vez)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, '..', '..', '..')
const PUBLICO = join(RAIZ, 'apps', 'web-internal', 'public')
const TEMPLATE = join(RAIZ, 'infra', 'oauth2-templates', 'sign_in.html')

const NORMAL = join(AQUI, 'pulse-icone.svg')
const MASCARA = join(AQUI, 'pulse-icone-maskable.svg')

/** Cada saída, com o tamanho e a arte de origem. Os tamanhos são os do Allvoice. */
const SAIDAS = [
  { arquivo: 'favicon.png', tamanho: 32, arte: NORMAL },
  { arquivo: 'icon-192.png', tamanho: 192, arte: NORMAL },
  { arquivo: 'icon-512.png', tamanho: 512, arte: NORMAL },
  { arquivo: 'apple-touch-icon.png', tamanho: 256, arte: NORMAL },
  { arquivo: 'icon-maskable-512.png', tamanho: 512, arte: MASCARA },
]

/** Tira comentário e espaço à toa — o data URI vai inteiro dentro do HTML. */
export function enxugar(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * O favicon da tela de entrada vai como DATA URI, e é decisão.
 *
 * Essa tela é servida pelo oauth2-proxy, que só entrega os templates dele. Um
 * `<link href="/favicon.png">` cairia na `location /` do nginx, que exige sessão
 * — e devolveria a própria tela de entrada, em HTML, no lugar da imagem. O
 * navegador mostraria ícone quebrado, sem nenhum erro em lugar nenhum.
 */
export function linkDoFavicon(svg) {
  const dados = Buffer.from(enxugar(svg), 'utf8').toString('base64')
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${dados}">`
}

const ABRE = '<!-- favicon:gerado -->'
const FECHA = '<!-- /favicon:gerado -->'

export function embutirNoTemplate(html, svg) {
  const bloco = `${ABRE}\n${linkDoFavicon(svg)}\n${FECHA}`
  if (html.includes(ABRE)) {
    return html.replace(new RegExp(`${ABRE}[\\s\\S]*?${FECHA}`), bloco)
  }
  return html.replace('</head>', `${bloco}\n</head>`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { chromium } = await import('playwright')
  const nav = await chromium.launch()
  for (const { arquivo, tamanho, arte } of SAIDAS) {
    const svg = readFileSync(arte, 'utf8')
    const p = await nav.newPage({ viewport: { width: tamanho, height: tamanho } })
    await p.setContent(
      `<style>html,body{margin:0;padding:0}svg{display:block;width:${tamanho}px;height:${tamanho}px}</style>${svg}`,
    )
    await p.screenshot({ path: join(PUBLICO, arquivo), omitBackground: true })
    await p.close()
    console.log(`  ${arquivo} · ${tamanho}px`)
  }
  await nav.close()

  writeFileSync(join(PUBLICO, 'icon.svg'), readFileSync(NORMAL, 'utf8'))
  console.log('  icon.svg')

  writeFileSync(TEMPLATE, embutirNoTemplate(readFileSync(TEMPLATE, 'utf8'), readFileSync(NORMAL, 'utf8')))
  console.log('  favicon embutido em sign_in.html')
}
