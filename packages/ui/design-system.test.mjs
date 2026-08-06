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
 *
 * A varredura ignora COMENTÁRIO, pelo mesmo motivo já registrado na regra de cor:
 * um `<button>` citado em prosa não desenha botão nenhum. Sem isto, o arquivo que
 * explica POR QUE o `<summary>` do menu de novidades não pode ser um `<Btn>` era
 * acusado duas vezes — e o único jeito de passar seria parar de nomear o elemento
 * de que o texto trata. Portão que obriga a escrever comentário pior está ensinando
 * a coisa errada. Código comentado também deixa de acusar, e é o certo: ele não
 * renderiza. O teste seguinte prova que a regra continua pegando código de verdade.
 */
test('nenhuma tela usa elemento de formulário cru', () => {
  const COMPONENTE = { textarea: 'TextArea', select: 'Select', input: 'Field', button: 'Btn' }
  const faltas = []

  for (const { caminho, texto } of ARQUIVOS) {
    if (caminho === relative(RAIZ, BASE)) continue
    // `temExcecao` continua lendo o texto ORIGINAL: o marcador vive num comentário.
    const codigo = semComentarios(texto)
    for (const [el, comp] of Object.entries(COMPONENTE)) {
      for (const m of codigo.matchAll(new RegExp(`<${el}\\b[^>]*`, 'gs'))) {
        if (el === 'input' && m[0].includes('type="hidden"')) continue
        if (temExcecao(texto, m.index)) continue
        const linha = texto.slice(0, m.index).split('\n').length
        faltas.push(`${caminho}:${linha} — <${el}> cru; use <${comp}> de @pulse/ui`)
      }
    }
  }

  assert.deepEqual(faltas, [], `\n${faltas.join('\n')}\n`)
})

test('a regra de elemento cru ainda pega botão em código, não só em comentário', () => {
  // O par da asserção equivalente da regra de cor: ignorar comentário só é seguro
  // enquanto o que sobra continua sendo varrido. Sem isto, um erro em
  // `semComentarios` apagaria o arquivo inteiro e o portão passaria vazio.
  const fingido = [
    '// um <button> citado em prosa não desenha botão',
    '/* nem <input> em bloco */',
    "const x = <button className='a' />",
    '<textarea rows={3} />',
  ].join('\n')
  const achados = [...semComentarios(fingido).matchAll(/<(button|input|textarea)\b/g)].map(
    (m) => m[1],
  )
  assert.deepEqual(achados, ['button', 'textarea'])
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

/**
 * As cores do e-mail não podem divergir dos tokens.
 *
 * `packages/mail/src/template.ts` precisa de hex literal: cliente de e-mail não
 * resolve `var()`, e Gmail e Outlook descartam `<style>` inteiro. A exceção é
 * legítima — mas exceção sem amarra é o começo da divergência, que é o defeito que
 * este arquivo inteiro existe para pegar.
 *
 * Então em vez de PERMITIR o hex, aqui se COMPARA: cada cor do template tem que
 * ser, byte a byte, um valor declarado em `estilo.css`. Trocar um token sem trocar
 * o e-mail passa a quebrar o portão em vez de sair só no e-mail de alguém.
 */
test('as cores do template de e-mail são as mesmas de estilo.css', () => {
  const template = readFileSync(join(RAIZ, 'packages', 'mail', 'src', 'template.ts'), 'utf8')
  const estilo = readFileSync(join(RAIZ, 'packages', 'ui', 'src', 'estilo.css'), 'utf8')

  const tokens = new Set(
    (estilo.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()),
  )
  assert.ok(tokens.size > 5, 'não li os tokens de estilo.css — o caminho mudou?')

  // Só o bloco COR: o resto do arquivo é `#fff` de texto sobre o gradiente e `#`
  // de href neutralizado, que não são cor de tema.
  const bloco = template.match(/const COR = \{([\s\S]*?)\} as const/)
  assert.ok(bloco, 'não achei o bloco COR em template.ts')

  for (const [, nome, hex] of bloco[1].matchAll(/(\w+):\s*'(#[0-9a-fA-F]{3,8})'/g)) {
    assert.ok(
      tokens.has(hex.toLowerCase()),
      `a cor "${nome}" do e-mail é ${hex}, que não existe em estilo.css — ` +
        `token trocado sem trocar o e-mail, ou aproximação em vez de cópia`,
    )
  }
})

/**
 * A tela do oauth2-proxy não pode divergir da do produto.
 *
 * `infra/oauth2-templates/sign_in.html` é servido por um binário Go que não
 * conhece o Tailwind nem o `estilo.css` — o CSS dele é inline e autossuficiente,
 * e não há como evitar isso. O que dá para evitar é a DIVERGÊNCIA, que é o custo
 * real dessa escolha: a tela do Publi e a do Allvoice já divergiram exatamente
 * assim, cada uma com o seu hex.
 *
 * Então em vez de permitir, compara-se — cor contra `estilo.css`, e o texto
 * contra os padrões do `Login.tsx`. Mexer num sem mexer no outro quebra o CI, em
 * vez de sair só no navegador de quem for entrar.
 */
const SIGN_IN = join(RAIZ, 'infra', 'oauth2-templates', 'sign_in.html')

test('as cores da tela do oauth2-proxy são as mesmas de estilo.css', () => {
  const html = readFileSync(SIGN_IN, 'utf8')
  const estilo = readFileSync(join(RAIZ, 'packages', 'ui', 'src', 'estilo.css'), 'utf8')
  const tokens = new Set((estilo.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()))

  // Só o bloco `:root`, que é onde moram as cores do tema. Fora dele há as
  // quatro do Google (marca de terceiro, proibido repintar) e `#fff`.
  const raiz = html.match(/:root \{([^}]*)\}/)
  assert.ok(raiz, 'não achei o bloco :root em sign_in.html')

  for (const [, nome, hex] of raiz[1].matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    assert.ok(
      tokens.has(hex.toLowerCase()),
      `a variável "${nome}" da tela de entrada é ${hex}, que não existe em estilo.css`,
    )
  }
})

test('o texto da tela do oauth2-proxy é o mesmo do Login.tsx', () => {
  const html = readFileSync(SIGN_IN, 'utf8')
  const login = readFileSync(join(RAIZ, 'packages', 'ui', 'src', 'Login.tsx'), 'utf8')

  // Os padrões do componente: é o que o usuário vê quando ninguém passa prop.
  const titulo = login.match(/titulo = '([^']+)'/)?.[1]
  const chamada = [...(login.match(/chamada = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1],
  )
  const etiquetas = [
    ...(login.match(/etiquetas = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g),
  ].map((m) => m[1])

  assert.ok(titulo && chamada.length && etiquetas.length, 'não li os padrões do Login.tsx')

  assert.ok(html.includes(titulo), `a tela de entrada não traz o título "${titulo}"`)
  for (const linha of chamada) {
    assert.ok(html.includes(linha), `a tela de entrada não traz a chamada "${linha}"`)
  }
  for (const e of etiquetas) {
    assert.ok(html.includes(`<span>${e}</span>`), `a tela de entrada não traz a etiqueta "${e}"`)
  }
})

/**
 * A marca do Pulse: cores do ícone, e o favicon embutido na tela de entrada.
 */
import { enxugar, linkDoFavicon } from './marca/gerar.mjs'

const ARTES = ['marca/pulse-icone.svg', 'marca/pulse-icone-maskable.svg']

test('as cores do ícone são as da marca', () => {
  const estilo = readFileSync(join(RAIZ, 'packages', 'ui', 'src', 'estilo.css'), 'utf8')
  const tokens = new Set((estilo.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => h.toLowerCase()))
  // O claro do gradiente não é token de tema — ele só existe dentro do ícone, e
  // foi MEDIDO no do Allvoice. Fica declarado aqui para não virar cor solta.
  const doIcone = new Set(['#8b57ef', '#ffffff'])

  for (const arte of ARTES) {
    // `enxugar` tira os comentários. Sem isso a asserção lê a PROSA do arquivo —
    // que cita as cores para explicá-las — em vez do desenho.
    const svg = enxugar(readFileSync(join(RAIZ, 'packages', 'ui', arte), 'utf8'))
    for (const hex of svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
      const h = hex.toLowerCase()
      assert.ok(
        tokens.has(h) || doIcone.has(h),
        `${arte} usa ${hex}, que não é token de estilo.css nem cor declarada do ícone`,
      )
    }
  }
})

test('o ícone tem UM acento laranja — a proporção é o que faz a família', () => {
  // No Allvoice o laranja é um ponto entre três. Laranja demais e o ícone deixa
  // de parecer irmão dos outros produtos da casa.
  for (const arte of ARTES) {
    const svg = enxugar(readFileSync(join(RAIZ, 'packages', 'ui', arte), 'utf8'))
    const laranja = (svg.match(/#FF7A00/gi) ?? []).length
    assert.equal(laranja, 1, `${arte} tem ${laranja} usos de laranja; o desenho prevê 1`)
  }
})

test('o favicon embutido na tela de entrada é o ícone ATUAL', () => {
  // A tela de entrada é servida pelo oauth2-proxy e carrega o ícone como data
  // URI — cópia, e cópia envelhece. Mexer no SVG sem rodar `pnpm --filter
  // @pulse/ui marca` deixaria a aba com o desenho velho, sem erro nenhum.
  const svg = readFileSync(join(RAIZ, 'packages', 'ui', 'marca', 'pulse-icone.svg'), 'utf8')
  const html = readFileSync(join(RAIZ, 'infra', 'oauth2-templates', 'sign_in.html'), 'utf8')
  assert.ok(
    html.includes(linkDoFavicon(svg)),
    'o favicon da tela de entrada não corresponde ao SVG — rode `pnpm --filter @pulse/ui marca`',
  )
})
