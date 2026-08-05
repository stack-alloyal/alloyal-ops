#!/usr/bin/env node
/**
 * Cadastra segredo em `ops.segredo` sem o valor passar por argv nem por histórico.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE POR STDIN, e não por argumento:                                     │
 * │                                                                            │
 * │ Valor em `argv` aparece em `ps` para qualquer processo da máquina enquanto o  │
 * │ comando roda, e fica no histórico do shell. Valor em variável de ambiente     │
 * │ aparece em `/proc/<pid>/environ`. Stdin não aparece em nenhum dos dois.       │
 * │                                                                            │
 * │ A CHAVE MESTRA continua vindo do ambiente, e é uma escolha consciente: ela    │
 * │ já vive assim nos contêineres da aplicação, e inventar um segundo caminho     │
 * │ para ela aqui não aumentaria a proteção — só criaria mais um lugar de onde    │
 * │ ela pode vazar.                                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Uso — uma linha `chave=valor` por segredo:
 *
 *   { printf 'lecupon.employee_token=%s\n' "$TOKEN"
 *     printf 'lecupon.employee_email=%s\n' "$EMAIL"
 *   } | PULSE_CHAVE_MESTRA=... DATABASE_URL=... node packages/config/cadastrar-segredo.cjs \
 *         --por stack@alloyal.com.br --dica 'copiado do Allvoice'
 *
 * O ideal é a origem do valor ser outro processo (`docker exec ... printenv`), para
 * ele nunca existir como texto no seu terminal.
 *
 * RECUSA chave que não está no catálogo: erro de digitação criaria segredo órfão, que
 * a tela não mostra e nenhum ciclo lê — e ninguém descobre até a integração quebrar.
 */
'use strict'

const pg = require('pg')

async function principal() {
  const args = process.argv.slice(2)
  const opcao = (nome, padrao) => {
    const i = args.indexOf(`--${nome}`)
    return i >= 0 && args[i + 1] ? args[i + 1] : padrao
  }
  const por = opcao('por', 'cli')
  const dica = opcao('dica', 'cadastrado pela linha de comando')
  const seco = args.includes('--seco')

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL não definida — sem banco não há onde gravar.')
    process.exit(1)
  }
  if (!process.env.PULSE_CHAVE_MESTRA) {
    console.error('PULSE_CHAVE_MESTRA não definida — sem ela o valor não pode ser cifrado.')
    process.exit(1)
  }

  // `@pulse/config` e `@pulse/auth` são ESM; daqui entram por import dinâmico.
  const { SEGREDOS } = await import('./dist/catalogo.js')
  const { cifrar } = await import('@pulse/auth')

  const bruto = await new Promise((resolve, reject) => {
    let b = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (b += d))
    process.stdin.on('end', () => resolve(b))
    process.stdin.on('error', reject)
  })

  const conhecidas = new Set(SEGREDOS.map((s) => s.chave))
  const pares = []
  for (const linha of bruto.split('\n')) {
    if (!linha.trim()) continue
    const i = linha.indexOf('=')
    if (i <= 0) {
      console.error('linha sem "=" — o formato é chave=valor, uma por linha.')
      process.exit(1)
    }
    const chave = linha.slice(0, i).trim()
    // Só o \r do fim: espaço interno pode fazer parte do valor, e "limpar" o valor de
    // um segredo é o jeito mais silencioso de gravar um token que não funciona.
    const valor = linha.slice(i + 1).replace(/\r$/, '')
    if (!conhecidas.has(chave)) {
      console.error(`"${chave}" não está no catálogo de segredos — nada foi gravado.`)
      console.error(`Chaves aceitas: ${[...conhecidas].sort().join(', ')}`)
      process.exit(1)
    }
    if (!valor) {
      console.error(`"${chave}" veio VAZIO — nada foi gravado.`)
      process.exit(1)
    }
    pares.push({ chave, valor })
  }
  if (pares.length === 0) {
    console.error('nada na entrada — nada foi gravado.')
    process.exit(1)
  }
  // O banco limita `dica` a 12 caracteres: ela é rótulo curto para a tela, não registro
  // de procedência. Barrar aqui em vez de deixar o CHECK recusar depois de imprimir
  // "gravado" — a mensagem do banco não diz qual é o limite nem por quê.
  if (dica.length > 12) {
    console.error(
      `--dica tem ${dica.length} caracteres e o limite é 12 (é rótulo de tela). ` +
        'Procedência vai no commit ou no ADR, não aqui.',
    )
    process.exit(1)
  }

  // O que é impresso: chave e TAMANHO. Nunca o valor, nem prefixo dele.
  for (const p of pares) {
    console.log(`  ${p.chave} · ${p.valor.length} caracteres`)
  }
  if (seco) {
    console.log('  --seco: nada foi gravado.')
    return
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 })
  try {
    for (const p of pares) {
      await pool.query(
        `INSERT INTO ops.segredo (chave, valor_cifrado, dica, atualizado_por)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chave) DO UPDATE
            SET valor_cifrado = $2, dica = $3, atualizado_por = $4, atualizado_em = now(),
                -- usado_em NAO e zerado: quem trocou o valor não desfez o fato de a
                -- credencial anterior ter sido usada, e apagar isso apagaria a única
                -- pista de quando a integração parou de funcionar.
                -- (sem crase neste comentário: crase dentro de template literal fecha
                --  a string, e o arquivo deixa de compilar.)
                usado_em = ops.segredo.usado_em`,
        [p.chave, cifrar(p.valor), dica, por],
      )
      console.log(`  gravado: ${p.chave}`)
    }
  } finally {
    await pool.end()
  }
}

principal().catch((e) => {
  // A mensagem de erro de cifra não contém o valor; a de banco pode conter a URL, então
  // só a primeira linha vai para a saída.
  console.error(String(e && e.message ? e.message : e).split('\n')[0])
  process.exit(1)
})
