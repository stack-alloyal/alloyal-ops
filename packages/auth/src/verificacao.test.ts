import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

import {
  assinarDispositivo,
  conferirCodigo,
  gerarCodigo,
  hashDoCodigo,
  lerCookie,
  MAX_TENTATIVAS,
  montarSetCookie,
  podeReenviar,
  stepUpAtivo,
  TTL_CODIGO_MS,
  TTL_DISPOSITIVO_MS,
  verificarDispositivo,
} from './verificacao.js'

const SEGREDO = 'segredo-de-verificacao-de-teste'
const AGORA = new Date('2026-08-01T12:00:00Z')
const EMAIL = 'pessoa@alloyal.com.br'

// ─── Trava anti-lockout ──────────────────────────────────────────────────────

test('sem envio configurado o step-up fica INERTE — não tranca ninguém', () => {
  // O caso que importa: credencial de e-mail expirou. Exigir código aqui deixaria
  // a plataforma inacessível para todos, inclusive para quem conserta.
  assert.equal(stepUpAtivo('true', SEGREDO, false), false)
})

test('sem segredo o step-up fica inerte', () => {
  assert.equal(stepUpAtivo('true', '', true), false)
  assert.equal(stepUpAtivo('true', '   ', true), false)
  assert.equal(stepUpAtivo('true', undefined, true), false)
})

test('a flag desligada desliga, mesmo com tudo configurado', () => {
  // A saída de emergência: PULSE_VERIFICACAO_EMAIL=false volta ao SSO puro.
  assert.equal(stepUpAtivo('false', SEGREDO, true), false)
  assert.equal(stepUpAtivo(undefined, SEGREDO, true), false)
})

test('com flag, segredo e envio, o step-up vale', () => {
  assert.equal(stepUpAtivo('true', SEGREDO, true), true)
})

// ─── Código ──────────────────────────────────────────────────────────────────

test('o código tem 6 dígitos, e zero à esquerda não some', () => {
  for (let i = 0; i < 300; i++) {
    const c = gerarCodigo()
    assert.match(c, /^[0-9]{6}$/, `código fora do formato: ${c}`)
  }
})

test('o hash muda com o segredo — tabela vazada não vira código', () => {
  // Sem o segredo dentro, 6 dígitos são 1.000.000 de hashes que um laptop
  // percorre num piscar: quem lesse a tabela saberia o código de todo mundo.
  const a = hashDoCodigo(EMAIL, '123456', SEGREDO)
  const b = hashDoCodigo(EMAIL, '123456', 'outro-segredo')
  assert.notEqual(a, b)
})

test('o hash é preso ao e-mail — código de um não vale para outro', () => {
  assert.notEqual(
    hashDoCodigo(EMAIL, '123456', SEGREDO),
    hashDoCodigo('outra@alloyal.com.br', '123456', SEGREDO),
  )
})

test('o e-mail é normalizado antes do hash', () => {
  assert.equal(hashDoCodigo(' PESSOA@Alloyal.com.BR ', '123456', SEGREDO), hashDoCodigo(EMAIL, '123456', SEGREDO))
})

const registro = (codigo: string, tentativas = 0, quando = AGORA) => ({
  hash: hashDoCodigo(EMAIL, codigo, SEGREDO),
  expiraEm: new Date(quando.getTime() + TTL_CODIGO_MS),
  tentativas,
})

test('o código certo passa', () => {
  assert.deepEqual(conferirCodigo(registro('123456'), EMAIL, '123456', SEGREDO, AGORA), { ok: true })
})

test('o código errado não passa', () => {
  const r = conferirCodigo(registro('123456'), EMAIL, '654321', SEGREDO, AGORA)
  assert.deepEqual(r, { ok: false, motivo: 'invalido' })
})

test('espaço em volta do código digitado não reprova quem acertou', () => {
  // Quem copia e cola do e-mail traz espaço junto. Reprovar aqui é reprovar o
  // acerto, e a pessoa não tem como saber por quê.
  assert.deepEqual(conferirCodigo(registro('123456'), EMAIL, ' 123456 ', SEGREDO, AGORA), { ok: true })
})

test('sem código emitido, recusa com motivo próprio', () => {
  assert.deepEqual(conferirCodigo(null, EMAIL, '123456', SEGREDO, AGORA), {
    ok: false,
    motivo: 'sem_codigo',
  })
})

test('código expirado é recusado mesmo estando certo', () => {
  const depois = new Date(AGORA.getTime() + TTL_CODIGO_MS + 1)
  assert.deepEqual(conferirCodigo(registro('123456'), EMAIL, '123456', SEGREDO, depois), {
    ok: false,
    motivo: 'expirado',
  })
})

test('expirado vence travado — a ordem das checagens é decisão', () => {
  // Dizer "travado" a quem tem código velho manda a pessoa esperar em vez de
  // pedir outro, que é o que resolve.
  const velhoETravado = { ...registro('123456', MAX_TENTATIVAS), expiraEm: new Date(AGORA.getTime() - 1) }
  assert.deepEqual(conferirCodigo(velhoETravado, EMAIL, '123456', SEGREDO, AGORA), {
    ok: false,
    motivo: 'expirado',
  })
})

test('no limite de tentativas trava, mesmo com o código certo', () => {
  assert.deepEqual(conferirCodigo(registro('123456', MAX_TENTATIVAS), EMAIL, '123456', SEGREDO, AGORA), {
    ok: false,
    motivo: 'travado',
  })
})

test('uma tentativa antes do limite ainda passa', () => {
  assert.deepEqual(
    conferirCodigo(registro('123456', MAX_TENTATIVAS - 1), EMAIL, '123456', SEGREDO, AGORA),
    { ok: true },
  )
})

// ─── Reenvio ─────────────────────────────────────────────────────────────────

test('sem envio anterior, pode enviar', () => {
  assert.equal(podeReenviar(null, AGORA).pode, true)
})

test('reenvio cedo demais é barrado e diz quanto falta', () => {
  const r = podeReenviar(new Date(AGORA.getTime() - 20_000), AGORA)
  assert.equal(r.pode, false)
  assert.equal(r.esperarMs, 40_000)
})

test('passado o intervalo, pode reenviar', () => {
  assert.equal(podeReenviar(new Date(AGORA.getTime() - 60_000), AGORA).pode, true)
})

// ─── Cookie de dispositivo ───────────────────────────────────────────────────

test('o cookie assinado por nós é aceito', () => {
  const { valor } = assinarDispositivo(EMAIL, SEGREDO, AGORA)
  assert.equal(verificarDispositivo(EMAIL, valor, SEGREDO, AGORA), true)
})

test('cookie de uma pessoa não vale para outra', () => {
  // Sem esta amarra, copiar o cookie de qualquer colega pularia a verificação.
  const { valor } = assinarDispositivo(EMAIL, SEGREDO, AGORA)
  assert.equal(verificarDispositivo('outra@alloyal.com.br', valor, SEGREDO, AGORA), false)
})

test('cookie com outro segredo é recusado', () => {
  const { valor } = assinarDispositivo(EMAIL, 'segredo-do-atacante', AGORA)
  assert.equal(verificarDispositivo(EMAIL, valor, SEGREDO, AGORA), false)
})

test('carga adulterada é recusada — a assinatura é conferida antes do conteúdo', () => {
  const forjada = Buffer.from(`${EMAIL}|${AGORA.getTime() + TTL_DISPOSITIVO_MS}`, 'utf8').toString(
    'base64url',
  )
  assert.equal(verificarDispositivo(EMAIL, `${forjada}.assinatura-inventada`, SEGREDO, AGORA), false)
})

test('cookie vencido é recusado', () => {
  const { valor } = assinarDispositivo(EMAIL, SEGREDO, AGORA)
  const muitoDepois = new Date(AGORA.getTime() + TTL_DISPOSITIVO_MS + 1)
  assert.equal(verificarDispositivo(EMAIL, valor, SEGREDO, muitoDepois), false)
})

test('lixo no lugar do cookie não derruba nem passa', () => {
  for (const t of [null, undefined, '', 'sem-ponto', '.', 'a.b', '!!!.???']) {
    assert.equal(verificarDispositivo(EMAIL, t, SEGREDO, AGORA), false)
  }
})

test('separador dentro da carga não confunde a leitura', () => {
  // A carga é cortada no ÚLTIMO `|`, não no primeiro. Com `split('|')[0]` uma
  // carga com barra a mais leria e-mail truncado.
  const carga = `a|b@alloyal.com.br|${AGORA.getTime() + TTL_DISPOSITIVO_MS}`
  const p = Buffer.from(carga, 'utf8').toString('base64url')
  const sig = createHmac('sha256', SEGREDO).update(carga).digest('base64url')
  assert.equal(verificarDispositivo('a|b@alloyal.com.br', `${p}.${sig}`, SEGREDO, AGORA), true)
})

test('o Set-Cookie tem HttpOnly e SameSite, e Secure só em produção', () => {
  const prod = montarSetCookie(EMAIL, SEGREDO, AGORA, true)
  assert.match(prod, /HttpOnly/)
  assert.match(prod, /SameSite=Lax/)
  assert.match(prod, /Secure/)
  // Sem Secure em desenvolvimento: o navegador descarta cookie Secure em http,
  // e o sintoma seria "verifico e ele pede de novo", sem erro nenhum.
  assert.doesNotMatch(montarSetCookie(EMAIL, SEGREDO, AGORA, false), /Secure/)
})

test('lerCookie acha o certo entre vários', () => {
  const h = 'outro=1; pulse_ev=abc.def; mais=2'
  assert.equal(lerCookie(h, 'pulse_ev'), 'abc.def')
  assert.equal(lerCookie(h, 'nao_existe'), null)
  assert.equal(lerCookie(undefined, 'pulse_ev'), null)
})
