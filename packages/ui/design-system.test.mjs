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
const PRESET = join(RAIZ, 'packages', 'ui', 'tailwind-preset.ts')

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
  // `blue-50` deixou de ser cor de fora: o DS 2026 declarou um `blue` da casa, com
  // `50`, `DEFAULT` e `ink`. O Tailwind TAMBÉM tem `blue-50`, e o do preset ganha —
  // então a classe pinta o azul da casa. Sem esta ressalva o portão recusaria o
  // token novo com a mensagem errada ("paleta padrão"), que é o pior tipo de erro
  // de portão: manda consertar o que já está certo. As outras faixas de `blue`
  // continuam recusadas, porque essas o preset não define.
  const DA_CASA = new Set(['blue-50'])
  const fora = []
  for (const { caminho, texto } of ARQUIVOS) {
    for (const m of texto.matchAll(PADRAO)) {
      if (DA_CASA.has(m[0].slice(m[0].indexOf('-') + 1))) continue
      const linha = texto.slice(0, m.index).split('\n').length
      fora.push(`${caminho}:${linha} — ${m[0]}`)
    }
  }
  assert.deepEqual(fora, [], `\n${fora.join('\n')}\n`)
})

/**
 * Contraste do texto colorido.
 *
 * O DS 2026 trocou os VALORES por baixo dos nomes que as telas já escreviam, e um
 * deles ficou ilegível: o amarelo do DS dá 1.87:1 sobre branco. Quem escreve
 * `text-amber` não tem como perceber — o nome continua o mesmo, o número muda no
 * preset, e o `pnpm build` passa. Foi assim que o valor de um KPI cujo comentário
 * diz "cor aqui significa saúde" ficou invisível exatamente onde importa.
 *
 * Mede-se contra `#FFFFFF`, o `surface`, que é o fundo mais CLARO da paleta. É de
 * propósito: sobre o fundo mais claro o contraste é o MELHOR caso, então o que
 * falha aqui falha em qualquer fundo da casa, e o portão não acusa à toa. Falso
 * positivo é como um portão passa a ser ignorado — ver a regra do `inputCls`.
 *
 * Limiar único de 4.5:1, sem a folga de 3:1 que a WCAG dá a texto grande: o token
 * não sabe em que tamanho será usado, e um que só passa a 30px é armadilha armada
 * para o primeiro reuso a 13px.
 *
 * O que este portão NÃO alcança, e é honesto dizer: tom que o preset não declara
 * — `text-amber-700` é o caso real, com 16 usos — cai na paleta padrão do
 * Tailwind, e daqui não se resolve o valor dele. Medido à mão dá 5.02:1, mas o
 * portão não o vê.
 */
const CONTRASTE_MINIMO = 4.5

/**
 * As tintas fracas aceitas, cada uma com motivo — a mesma exigência do `ds-excecao`:
 * silenciador anônimo é como a regra morre.
 *
 * As duas são a escala de texto esmaecido, e as duas JÁ falhavam antes do DS 2026
 * (2.78:1 e 1.83:1). O DS piorou as duas de leve, e endurecê-las mexeria em 155 usos
 * de `ink-3` — mudança visual ampla, adiada por decisão de 06/08/2026. Ficam
 * declaradas para que a dívida seja visível em vez de esquecida.
 */
const TINTA_FRACA_ACEITA = {
  'ink-3': 'escala de texto esmaecido, 2.58:1 — 155 usos, endurecer é mudança visual ampla (06/08/2026)',
  'ink-4': 'o mais fraco da escala, 1.47:1 — serve a traço e placeholder, não a texto que se lê',
}

/** Recorta o objeto `colors` do preset, contando chaves para achar o fecho certo. */
function blocoDeCores(fonte) {
  const abre = fonte.indexOf('colors: {')
  if (abre < 0) return null
  let i = fonte.indexOf('{', abre)
  let nivel = 0
  for (let j = i; j < fonte.length; j++) {
    if (fonte[j] === '{') nivel++
    else if (fonte[j] === '}' && --nivel === 0) return fonte.slice(i + 1, j)
  }
  return null
}

/**
 * Os tokens de cor do preset que são hex literal, achatados no nome da classe:
 * `ink` + `2` → `ink-2`, e `DEFAULT` → o nome sozinho. Os semânticos do shadcn são
 * `hsl(var(--x))` e caem fora por não casarem com hex — que é o certo, porque o
 * valor deles vive no CSS e não aqui.
 */
function tokensDeCor() {
  const bloco = blocoDeCores(semComentarios(readFileSync(PRESET, 'utf8')))
  assert.ok(bloco, 'não achei o objeto `colors` no tailwind-preset.ts — o arquivo mudou de forma?')

  const tokens = new Map()
  // Grupos primeiro (`ink: { ... }`), depois some com eles para as chaves soltas
  // não serem lidas duas vezes.
  let solto = bloco
  for (const m of bloco.matchAll(/(\w+):\s*\{([^{}]*)\}/g)) {
    for (const [, chave, hex] of m[2].matchAll(/(\w+):\s*'(#[0-9a-fA-F]{3,8})'/g)) {
      tokens.set(chave === 'DEFAULT' ? m[1] : `${m[1]}-${chave}`, hex)
    }
    solto = solto.replace(m[0], '')
  }
  for (const [, nome, hex] of solto.matchAll(/(\w+):\s*'(#[0-9a-fA-F]{3,8})'/g)) {
    tokens.set(nome, hex)
  }
  return tokens
}

/** Luminância relativa da WCAG. */
function luminancia(hex) {
  const canal = (n) => {
    const c = n / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b)
}

function contraste(a, b) {
  const [claro, escuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
  return (claro + 0.05) / (escuro + 0.05)
}

test('a conta de contraste é a da WCAG', () => {
  // Sem isto, um erro na fórmula deixaria o portão abaixo verde afirmando o que não
  // verificou. Os três pares são os do próprio texto da norma.
  assert.equal(contraste('#000000', '#FFFFFF').toFixed(2), '21.00')
  assert.equal(contraste('#FFFFFF', '#FFFFFF').toFixed(2), '1.00')
  assert.equal(contraste('#767676', '#FFFFFF') >= 4.5, true)
})

test('os tokens de cor do preset são legíveis pelo portão', () => {
  // O par da asserção "há arquivos para varrer": se o recorte do preset falhar, o
  // portão de contraste varre o vazio e passa sem medir nada.
  const tokens = tokensDeCor()
  assert.ok(tokens.size > 20, `li só ${tokens.size} tokens do preset — o recorte quebrou?`)
  for (const nome of ['ink', 'ink-2', 'amber', 'amber-ink', 'green', 'red', 'purple-500']) {
    assert.match(tokens.get(nome) ?? '', /^#[0-9a-fA-F]{6}$/, `token \`${nome}\` não foi lido`)
  }
})

test('todo texto colorido passa 4.5:1 sobre o surface', () => {
  const tokens = tokensDeCor()
  const SURFACE = tokens.get('surface')
  assert.match(SURFACE ?? '', /^#[0-9a-fA-F]{6}$/, 'não li o token `surface`')

  const fracos = []
  for (const { caminho, texto } of ARQUIVOS) {
    for (const m of semComentarios(texto).matchAll(/\btext-([a-z]+(?:-[a-z0-9]+)?)\b/g)) {
      const hex = tokens.get(m[1])
      if (!hex) continue // tamanho (`text-b2`), arbitrário, ou tom do Tailwind
      if (m[1] in TINTA_FRACA_ACEITA) continue
      const r = contraste(hex, SURFACE)
      if (r >= CONTRASTE_MINIMO) continue
      const linha = texto.slice(0, m.index).split('\n').length
      fracos.push(
        `${caminho}:${linha} — text-${m[1]} é ${hex}, ${r.toFixed(2)}:1 sobre ${SURFACE}; ` +
          `use a tinta do par (\`-ink\`) ou um tom mais escuro`,
      )
    }
  }
  assert.deepEqual(fracos, [], `\n${fracos.join('\n')}\n`)
})

test('a regra de contraste ainda pega tinta fraca de verdade', () => {
  // Prova em cima do amarelo REAL do DS, que é o defeito que motivou este portão:
  // se algum dia ele voltar a ser aceito, este teste cai junto.
  const tokens = tokensDeCor()
  assert.ok(contraste(tokens.get('amber'), tokens.get('surface')) < CONTRASTE_MINIMO)
  assert.ok(contraste(tokens.get('amber-ink'), tokens.get('surface')) >= CONTRASTE_MINIMO)
  // E a exceção precisa continuar sendo exceção: token declarado sem motivo escrito
  // não vale.
  for (const [nome, motivo] of Object.entries(TINTA_FRACA_ACEITA)) {
    assert.ok(motivo.trim().length >= 15, `a exceção \`${nome}\` não traz motivo`)
    assert.ok(tokens.has(nome), `a exceção \`${nome}\` não é token do preset`)
  }
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
