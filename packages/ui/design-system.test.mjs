/**
 * Portão do design system: as telas usam os componentes, e não uma cópia deles.
 *
 * Existe por causa de um defeito real encontrado numa auditoria. O `TextArea` do
 * alloyal-publi nunca foi portado, então as duas telas que precisavam de campo longo
 * copiaram as classes do `inputCls` à mão — e as duas cópias JÁ tinham divergido entre
 * si: uma em `text-[13px]` com regra de placeholder, a outra em `text-[13.5px]` sem.
 * Ninguém nota, porque as duas telas não se abrem lado a lado.
 *
 * É o mesmo padrão que já obrigou `papeis.test.ts` e `migracoes.test.ts` a existirem:
 * lista duplicada diverge, e a revisão de código não pega — cada arquivo parece certo
 * sozinho. Só a asserção que olha os dois ao mesmo tempo pega.
 *
 * Roda sem build e sem banco: é varredura de arquivo, não precisa de tipos.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = join(RAIZ, 'packages', 'ui', 'src', 'base.tsx')

/** Todo .tsx da app e da biblioteca, menos o que o build gera. */
function tsx(dir, achados = []) {
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome === '.next' || nome === 'dist') continue
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) tsx(p, achados)
    else if (nome.endsWith('.tsx')) achados.push(p)
  }
  return achados
}

const ARQUIVOS = [
  ...tsx(join(RAIZ, 'apps', 'web-internal', 'app')),
  ...tsx(join(RAIZ, 'apps', 'web-portal', 'app')),
  ...tsx(join(RAIZ, 'packages', 'ui', 'src')),
].map((p) => ({ caminho: relative(RAIZ, p), texto: readFileSync(p, 'utf8') }))

test('há arquivos para varrer', () => {
  // Sem isto, um erro de caminho faz o portão passar varrendo o vazio — o pior
  // tipo de teste verde, porque afirma exatamente o que não verificou.
  assert.ok(ARQUIVOS.length > 15, `varreu só ${ARQUIVOS.length} arquivos — caminho errado?`)
})

/**
 * A exceção declarada.
 *
 * Existe um caso legítimo: o valor do `Metric` é um `<button>` porque precisa receber
 * foco de teclado para revelar a procedência do número, e é estilizado como
 * `border-0 bg-transparent` justamente para NÃO parecer botão. Trocá-lo por `<Btn>`
 * aplicaria a aparência errada.
 *
 * Em vez de afrouxar a regra para todos, a exceção se declara no código com motivo.
 * Marcador sem motivo não vale: silenciador anônimo é como a regra morre — alguém
 * cola o marcador para o teste passar e ninguém descobre por quê.
 */
const MARCADOR = /ds-excecao:\s*(\S[^*\n]*)/

function temExcecao(texto, indice) {
  const antes = texto.slice(Math.max(0, indice - 400), indice)
  const m = antes.match(new RegExp(MARCADOR.source + '[\\s\\S]*$'))
  return m !== null && m[1].trim().length >= 15
}

/**
 * Elemento de formulário cru onde já existe componente.
 *
 * `type="hidden"` fica de fora: não tem aparência, e embrulhá-lo num rótulo seria
 * pior. `base.tsx` é a definição dos componentes — é onde os elementos crus devem
 * estar.
 */
test('nenhuma tela usa elemento de formulário cru', () => {
  const COMPONENTE = { textarea: 'TextArea', select: 'Select', input: 'Field', button: 'Btn' }
  const faltas = []

  for (const { caminho, texto } of ARQUIVOS) {
    if (caminho === relative(RAIZ, BASE)) continue
    for (const [el, comp] of Object.entries(COMPONENTE)) {
      for (const m of texto.matchAll(new RegExp(`<${el}\\b[^>]*`, 'gs'))) {
        if (el === 'input' && m[0].includes('type="hidden"')) continue
        if (temExcecao(texto, m.index)) continue
        const linha = texto.slice(0, m.index).split('\n').length
        faltas.push(`${caminho}:${linha} — <${el}> cru; use <${comp}> de @pulse/ui`)
      }
    }
  }

  assert.deepEqual(faltas, [], `\n${faltas.join('\n')}\n`)
})

/**
 * Cópia à mão das classes do campo.
 *
 * A assinatura é `focus:ring-purple-100`, o anel de foco do campo: existe uma única
 * vez no repo, dentro do `inputCls`. Encontrá-lo em outro arquivo significa que
 * alguém reconstruiu o campo em vez de importá-lo.
 *
 * A primeira versão desta regra procurava `border-line-strong` + `bg-surface` no
 * arquivo inteiro, e acusou três lugares que não têm campo nenhum: `border-line-strong`
 * também é a borda tracejada do `Vazio` e dos cartões. Assinatura larga demais gera
 * falso positivo, e falso positivo é como um portão passa a ser ignorado.
 */
test('nenhuma cópia à mão do inputCls', () => {
  const copias = ARQUIVOS.filter(
    ({ caminho, texto }) =>
      caminho !== relative(RAIZ, BASE) && texto.includes('focus:ring-purple-100'),
  ).map(({ caminho }) => caminho)

  assert.deepEqual(copias, [], `cópia do inputCls em: ${copias.join(', ')} — importe de @pulse/ui`)
})

/**
 * Comentários fora, mantendo o número da linha.
 *
 * A primeira versão da regra de cor varria o arquivo inteiro e acusou duas vezes um
 * hex que eu havia escrito em COMENTÁRIO — uma vez explicando por que a folha de
 * impressão usa `--surface`, outra explicando quais cinzas do Allvoice foram
 * deliberadamente NÃO copiados. Hex em prosa não pinta nada, e um portão que obriga a
 * reescrever a explicação para passar está ensinando a escrever comentário pior.
 *
 * Troca por espaço em vez de remover, para o número da linha continuar apontando o
 * lugar certo no erro.
 */
function semComentarios(texto) {
  const branco = (c) => c.replace(/[^\n]/g, ' ')
  return (
    texto
      .replace(/\/\*[\s\S]*?\*\//g, branco)
      // `(^|[^:])` deixa `https://` em paz: sem isso, uma URL numa linha apagaria o
      // resto dela e a varredura passaria por cima de um hex real logo depois.
      .replace(/(^|[^:])\/\/[^\n]*/gm, (c, antes) => antes + branco(c.slice(antes.length)))
  )
}

/**
 * Cor fora do token.
 *
 * Hex só pode existir onde os tokens são DEFINIDOS (`estilo.css`), no logo (que é um
 * SVG de marca) e nos dois tons do `Badge` que o próprio Publi declara em hex. Fora
 * disso, hex é cor que o tema não controla — e que não acompanha nenhuma mudança de
 * paleta.
 *
 * Inclui as cores do logotipo do Google: elas são reais e legítimas, e por isso vivem
 * em `estilo.css` (`.g-azul` e as outras três) em vez de num `fill` do componente.
 * Abrir exceção aqui custaria mais que a indireção — invariante com exceção é
 * invariante que ninguém confia.
 */
test('nenhuma cor cravada fora dos tokens', () => {
  const cravadas = []
  for (const { caminho, texto } of ARQUIVOS) {
    if (caminho.endsWith('AlloyalLogo.tsx') || caminho === relative(RAIZ, BASE)) continue
    for (const m of semComentarios(texto).matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const linha = texto.slice(0, m.index).split('\n').length
      cravadas.push(`${caminho}:${linha} — ${m[0]}`)
    }
  }
  assert.deepEqual(cravadas, [], `\n${cravadas.join('\n')}\n`)
})

test('a regra de cor ainda pega hex em código, não só em comentário', () => {
  // Sem isto, `semComentarios` poderia mascarar tudo e o teste acima passaria vazio —
  // um portão que não recusa nada é pior que nenhum portão, porque parece cobertura.
  const fingido = [
    'const a = 1 // #AAAAAA no fim da linha',
    '  // #BBBBBB em linha própria',
    '/* #CCCCCC em bloco */',
    "const doc = 'https://x.dev/a' // e a URL não come o resto",
    "const cor = '#123456'",
    "const svg = <path fill='#654321' />",
  ].join('\n')
  const achados = [...semComentarios(fingido).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  assert.deepEqual(achados, ['#123456', '#654321'])
})

/**
 * Paleta padrão do Tailwind.
 *
 * `gray-500` existe e funciona, e é exatamente o problema: renderiza um cinza que não
 * é o cinza da Alloyal, e ninguém percebe porque cinza parece com cinza. A paleta da
 * casa é `ink`, `line`, `surface`, `purple`, `orange`.
 */
test('nenhuma cor da paleta padrão do Tailwind', () => {
  const PADRAO =
    /\b(?:text|bg|border|ring|from|to|via)-(gray|slate|zinc|neutral|stone|blue|indigo|sky|violet|emerald|teal|cyan|rose|fuchsia|lime|yellow)-\d{2,3}\b/g
  const fora = []
  for (const { caminho, texto } of ARQUIVOS) {
    for (const m of texto.matchAll(PADRAO)) {
      const linha = texto.slice(0, m.index).split('\n').length
      fora.push(`${caminho}:${linha} — ${m[0]}`)
    }
  }
  assert.deepEqual(fora, [], `\n${fora.join('\n')}\n`)
})

/**
 * Os tons do Badge são fechados.
 *
 * `tone="verde"` em português compila (é string) e renderiza sem cor nenhuma —
 * silenciosamente. O `Tom` exportado existe para isso, mas só protege quem o usa.
 */
test('todo tone= do Badge existe em base.tsx', () => {
  const base = readFileSync(BASE, 'utf8')
  const decl = base.match(/export type Tom =([^\n]+)/)
  assert.ok(decl, 'não achei `export type Tom` em base.tsx')
  const validos = new Set([...decl[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]))

  const invalidos = []
  for (const { caminho, texto } of ARQUIVOS) {
    for (const m of texto.matchAll(/tone="([a-z]+)"/g)) {
      if (!validos.has(m[1])) {
        const linha = texto.slice(0, m.index).split('\n').length
        invalidos.push(`${caminho}:${linha} — tone="${m[1]}"`)
      }
    }
  }
  assert.deepEqual(invalidos, [], `\n${invalidos.join('\n')}\n`)
})
