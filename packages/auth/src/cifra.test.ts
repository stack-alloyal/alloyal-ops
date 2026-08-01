/**
 * A cifra dos segredos.
 *
 * O teste que importa mais aqui não é o de ida-e-volta — é o de ADULTERAÇÃO. A razão
 * de ser GCM e não CBC é que quem tem escrita no banco sem ter a chave não consiga
 * TROCAR um token por outro: num token de API, trocar significa apontar a integração
 * para um servidor de terceiro, e com CBC a decifragem produziria lixo plausível em
 * vez de recusar.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import {
  ChaveMestraAusenteError,
  SegredoCorrompidoError,
  chaveMestraConfigurada,
  cifradoComAChaveAtual,
  cifrar,
  decifrar,
  dica,
  iguais,
  rotacaoEmCurso,
} from './cifra.js'

// Chave só do teste. 32 bytes em base64, como a de produção exige.
const CHAVE = Buffer.alloc(32, 7).toString('base64')
const OUTRA = Buffer.alloc(32, 9).toString('base64')

let anterior: string | undefined

beforeEach(() => {
  anterior = process.env['PULSE_CHAVE_MESTRA']
  process.env['PULSE_CHAVE_MESTRA'] = CHAVE
})

afterEach(() => {
  if (anterior === undefined) delete process.env['PULSE_CHAVE_MESTRA']
  else process.env['PULSE_CHAVE_MESTRA'] = anterior
  // A variável de rotação some entre testes: deixá-la vazando faria um teste
  // decifrar por causa do anterior e passar sem testar o que diz testar.
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
})

test('ida e volta preserva o valor', () => {
  // O valor de mentira NÃO imita o formato de nenhum provedor. A primeira versão usava
  // `pat-na1-…`, o formato de PAT do HubSpot, e o scanner de segredo do GitHub barrou o
  // push — corretamente. Fixture parecida com credencial real tem dois custos: treina
  // o scanner a ignorar aquele padrão, e convida alguém a colar um token de verdade no
  // lugar "porque é só um teste".
  const token = 'VALOR-DE-MENTIRA-PARA-TESTE-nao-e-credencial-de-ninguem'
  assert.equal(decifrar(cifrar(token)), token)
})

test('acentos e unicode sobrevivem', () => {
  // Um segredo pode ser senha de SMTP escolhida por humano.
  const s = 'sÉnh@-com-acento-e-emoji-🔐-mais-de-oito'
  assert.equal(decifrar(cifrar(s)), s)
})

test('o mesmo valor cifrado duas vezes dá texto DIFERENTE', () => {
  // IV aleatório por operação. Sem isso, dois clientes com o mesmo token teriam a
  // mesma linha no banco — e quem lê o dump descobre isso sem decifrar nada.
  const a = cifrar('token-repetido-aqui')
  const b = cifrar('token-repetido-aqui')
  assert.notEqual(a, b)
  assert.equal(decifrar(a), decifrar(b))
})

test('ADULTERAR o texto cifrado é recusado', () => {
  const guardado = cifrar('token-original-do-hubspot')
  const [v, iv, tag, cifrado] = guardado.split(':') as [string, string, string, string]

  // Troca um caractere do corpo cifrado. Com AES-CBC isto produziria bytes diferentes
  // e a aplicação usaria o resultado; com GCM a tag não fecha.
  const mexido = (cifrado.startsWith('A') ? 'B' : 'A') + cifrado.slice(1)
  assert.notDeepEqual(
    Buffer.from(mexido, 'base64url'),
    Buffer.from(cifrado, 'base64url'),
    'a mutação não mudou os bytes',
  )
  assert.throws(() => decifrar([v, iv, tag, mexido].join(':')), SegredoCorrompidoError)
})

test('ADULTERAR a tag é recusado', () => {
  const [v, iv, tag, c] = cifrar('token-para-testar-tag').split(':') as [string, string, string, string]
  // O PRIMEIRO caractere, e não o último: 16 bytes em base64url dão 22 caracteres, e o
  // último carrega só 4 bits úteis — trocá-lo pode decodificar para os MESMOS bytes, e
  // o teste passaria a afirmar que adulteração é detectada sem ter adulterado nada.
  const mexida = (tag.startsWith('A') ? 'B' : 'A') + tag.slice(1)
  assert.notDeepEqual(
    Buffer.from(mexida, 'base64url'),
    Buffer.from(tag, 'base64url'),
    'a mutação não mudou os bytes — o teste não testaria nada',
  )
  assert.throws(() => decifrar([v, iv, mexida, c].join(':')), SegredoCorrompidoError)
})

test('trocar o IV é recusado', () => {
  const [v, , tag, c] = cifrar('token-para-testar-iv').split(':') as [string, string, string, string]
  const outroIv = Buffer.alloc(12, 3).toString('base64url')
  assert.throws(() => decifrar([v, outroIv, tag, c].join(':')), SegredoCorrompidoError)
})

test('chave diferente NÃO decifra', () => {
  const guardado = cifrar('token-cifrado-com-a-chave-certa')
  process.env['PULSE_CHAVE_MESTRA'] = OUTRA
  assert.throws(() => decifrar(guardado), SegredoCorrompidoError)
})

test('versão desconhecida é recusada em vez de tentada', () => {
  const g = cifrar('token-qualquer-aqui').replace(/^v1:/, 'v9:')
  assert.throws(() => decifrar(g), /v9/)
})

test('formato quebrado não derruba com erro de índice', () => {
  for (const ruim of ['', 'v1', 'v1:a:b', 'v1:a:b:c:d', 'lixo']) {
    assert.throws(() => decifrar(ruim), SegredoCorrompidoError, `aceitou "${ruim}"`)
  }
})

test('sem chave mestra, falha fechado e com instrução', () => {
  delete process.env['PULSE_CHAVE_MESTRA']
  assert.equal(chaveMestraConfigurada(), false)
  assert.throws(() => cifrar('qualquer-coisa-aqui'), ChaveMestraAusenteError)
  // A mensagem tem que dizer COMO gerar: quem encontra esse erro está num deploy
  // travado, e "variável não configurada" não desbloqueia ninguém.
  assert.throws(() => cifrar('qualquer-coisa-aqui'), /openssl rand -base64 32/)
})

test('chave de tamanho errado é recusada em vez de aceita mais fraca', () => {
  process.env['PULSE_CHAVE_MESTRA'] = Buffer.alloc(16, 1).toString('base64')
  assert.throws(() => cifrar('qualquer-coisa-aqui'), /16 bytes.*32/s)
})

test('segredo vazio não se cifra', () => {
  assert.throws(() => cifrar(''), /vazio/)
})

// ── A dica ──────────────────────────────────────────────────────────────────

test('a dica mostra 4 letras e esconde o resto', () => {
  assert.equal(dica('MENTIRA-abcdefghij0123'), '····0123')
})

test('segredo curto não mostra NADA', () => {
  // Quatro de doze é fração demais: num segredo curto, o sufixo entrega o valor.
  assert.equal(dica('curto123'), '····')
  assert.equal(dica('onzeletras1'), '····')
})

test('a dica nunca contém o começo do segredo', () => {
  const s = 'PREFIXO-QUE-NAO-PODE-APARECER-1234'
  assert.equal(dica(s).includes('PREFIXO'), false)
})

// ── Comparação ──────────────────────────────────────────────────────────────

test('iguais compara valor e recusa tamanho diferente', () => {
  assert.equal(iguais('abc', 'abc'), true)
  assert.equal(iguais('abc', 'abd'), false)
  // Tamanho diferente devolve false sem chamar timingSafeEqual, que lançaria.
  assert.equal(iguais('abc', 'abcd'), false)
})

// ── Rotação da chave mestra ─────────────────────────────────────────────────

test('trocar a chave SEM a anterior torna o segredo indecifrável', () => {
  // É o cenário que motivou tudo isto: alguém roda `openssl rand` e substitui
  // PULSE_CHAVE_MESTRA achando que rotacionou. Sem a anterior, o que já estava
  // gravado vira lixo — e não há volta, porque a chave velha não ficou em lugar nenhum.
  const guardado = cifrar('token-cifrado-com-a-chave-original')
  process.env['PULSE_CHAVE_MESTRA'] = OUTRA
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
  assert.throws(() => decifrar(guardado), SegredoCorrompidoError)
})

test('com a anterior declarada, o segredo antigo continua legível', () => {
  const guardado = cifrar('token-cifrado-com-a-chave-original')
  process.env['PULSE_CHAVE_MESTRA'] = OUTRA
  process.env['PULSE_CHAVE_MESTRA_ANTERIOR'] = CHAVE
  assert.equal(decifrar(guardado), 'token-cifrado-com-a-chave-original')
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
})

test('depois de regravado, decifra com a NOVA e não depende mais da velha', () => {
  const claro = 'token-que-sera-regravado-na-rotacao'
  const antigo = cifrar(claro)

  process.env['PULSE_CHAVE_MESTRA'] = OUTRA
  process.env['PULSE_CHAVE_MESTRA_ANTERIOR'] = CHAVE
  const regravado = cifrar(decifrar(antigo)) // é o que `rotacionarSegredos` faz

  // A prova de que a rotação TERMINOU: sem a anterior, o valor novo ainda abre.
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
  assert.equal(decifrar(regravado), claro)
  // E o antigo, esse sim, deixou de abrir — como tem que ser.
  assert.throws(() => decifrar(antigo), SegredoCorrompidoError)
})

test('cifradoComAChaveAtual distingue o que já foi regravado', () => {
  const antigo = cifrar('valor-na-chave-velha')
  process.env['PULSE_CHAVE_MESTRA'] = OUTRA
  process.env['PULSE_CHAVE_MESTRA_ANTERIOR'] = CHAVE
  const novo = cifrar('valor-na-chave-nova')

  // É o que responde "posso apagar a variável da chave anterior?".
  assert.equal(cifradoComAChaveAtual(novo), true)
  assert.equal(cifradoComAChaveAtual(antigo), false)
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
})

test('rotacaoEmCurso reflete a variável, e a mensagem de erro diz que tentou as duas', () => {
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
  assert.equal(rotacaoEmCurso(), false)

  const lixo = cifrar('valor-qualquer-para-o-teste')
  process.env['PULSE_CHAVE_MESTRA'] = OUTRA
  process.env['PULSE_CHAVE_MESTRA_ANTERIOR'] = Buffer.alloc(32, 3).toString('base64')
  assert.equal(rotacaoEmCurso(), true)
  // Quem lê o log precisa saber que a chave anterior TAMBÉM não serviu — senão
  // gasta a próxima hora procurando a variável que já estava lá.
  assert.throws(() => decifrar(lixo), /atual e com a anterior/)
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
})

test('chave anterior com tamanho errado é recusada, não ignorada', () => {
  // Ignorar em silêncio faria a rotação "funcionar" e deixar segredos para trás.
  const guardado = cifrar('token-para-o-teste-de-tamanho')
  process.env['PULSE_CHAVE_MESTRA'] = OUTRA
  process.env['PULSE_CHAVE_MESTRA_ANTERIOR'] = Buffer.alloc(16, 1).toString('base64')
  assert.throws(() => decifrar(guardado), /PULSE_CHAVE_MESTRA_ANTERIOR.*16 bytes/s)
  delete process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
})
