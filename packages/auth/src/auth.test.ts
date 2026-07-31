import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PAPEIS, PERMISSOES, permissoesDe } from './papeis.js'
import {
  ConfiguracaoInsegura,
  HEADER_EMAIL,
  HEADER_SEGREDO,
  identidadeDaRequisicao,
  ipEmFaixa,
  permiteIdentidadeDeDesenvolvimento,
  segredosIguais,
} from './proxy.js'
import { emitirToken, hashToken, validarToken } from './magic-link.js'

const FAIXAS = ['172.16.0.0/12', '127.0.0.1/32']
const SEGREDO = 'segredo-do-proxy-de-teste'
const opts = {
  faixasConfiaveis: FAIXAS,
  dominio: 'alloyal.com.br',
  papeisDe: async () => ['pulse-csm'],
}
const optsSegredo = {
  segredoDoProxy: SEGREDO,
  dominio: 'alloyal.com.br',
  papeisDe: async () => ['pulse-csm'],
}

// ─── Fronteira de confiança do cabeçalho ─────────────────────────────────────

test('identidade é aceita quando a requisição vem do proxy', async () => {
  const id = await identidadeDaRequisicao(
    { [HEADER_EMAIL]: 'pessoa@alloyal.com.br' },
    '172.18.0.5',
    opts,
  )
  assert.equal(id.email, 'pessoa@alloyal.com.br')
  assert.deepEqual(id.papeis, ['pulse-csm'])
})

test('cabeçalho de identidade de fora da faixa do proxy é ignorado', async () => {
  // O ataque: contêiner comprometido em outra rede da VM manda o cabeçalho e
  // vira administrador. Sem prova de proxy, autenticação por header é aberta.
  await assert.rejects(
    identidadeDaRequisicao({ [HEADER_EMAIL]: 'invasor@alloyal.com.br' }, '10.9.9.9', opts),
    /não comprovou ter passado pelo proxy/,
  )
})

test('sem IP de origem não há identidade', async () => {
  await assert.rejects(
    identidadeDaRequisicao({ [HEADER_EMAIL]: 'pessoa@alloyal.com.br' }, undefined, opts),
    /não comprovou ter passado pelo proxy/,
  )
})

// ── Prova por segredo compartilhado ──────────────────────────────────────────

test('o segredo do proxy autentica onde não há endereço de rede', async () => {
  // É o caso do Server Component do Next: só existem cabeçalhos, e o endereço
  // do peer não está disponível em lugar nenhum.
  const id = await identidadeDaRequisicao(
    { [HEADER_EMAIL]: 'pessoa@alloyal.com.br', [HEADER_SEGREDO]: SEGREDO },
    undefined,
    optsSegredo,
  )
  assert.equal(id.email, 'pessoa@alloyal.com.br')
})

test('segredo errado ou ausente não autentica', async () => {
  for (const h of [{}, { [HEADER_SEGREDO]: 'chute' }, { [HEADER_SEGREDO]: '' }]) {
    await assert.rejects(
      identidadeDaRequisicao(
        { [HEADER_EMAIL]: 'invasor@alloyal.com.br', ...h },
        undefined,
        optsSegredo,
      ),
      /não comprovou ter passado pelo proxy/,
    )
  }
})

test('x-forwarded-for NÃO serve como prova', async () => {
  // Seria circular: defender-se de cabeçalho falsificado usando outro cabeçalho.
  await assert.rejects(
    identidadeDaRequisicao(
      { [HEADER_EMAIL]: 'invasor@alloyal.com.br', 'x-forwarded-for': '172.18.0.5' },
      undefined,
      opts,
    ),
    /não comprovou ter passado pelo proxy/,
  )
})

test('sem NENHUMA prova configurada, a autenticação é recusada', async () => {
  // Configuração incompleta não pode virar sistema aberto — é o modo de falha
  // que transforma um esquecimento de deploy num acesso irrestrito.
  await assert.rejects(
    identidadeDaRequisicao({ [HEADER_EMAIL]: 'pessoa@alloyal.com.br' }, '172.18.0.5', {
      dominio: 'alloyal.com.br',
      papeisDe: async () => ['pulse-csm'],
    }),
    ConfiguracaoInsegura,
  )
})

test('a comparação do segredo não vaza por tamanho nem por conteúdo', () => {
  assert.equal(segredosIguais('abc', 'abc'), true)
  assert.equal(segredosIguais('abc', 'abd'), false)
  assert.equal(segredosIguais('abc', 'abcd'), false)
  assert.equal(segredosIguais('', ''), true)
})

test('domínio de fora é recusado mesmo vindo do proxy', async () => {
  // Segunda barreira, redundante com --email-domain do oauth2-proxy de propósito:
  // uma configuração errada no proxy não deve ser suficiente para entrar.
  await assert.rejects(
    identidadeDaRequisicao({ [HEADER_EMAIL]: 'alguem@gmail.com' }, '172.18.0.5', opts),
    /domínio não autorizado/,
  )
})

test('pessoa autenticada sem grupo recebe erro que diz como resolver', async () => {
  await assert.rejects(
    identidadeDaRequisicao({ [HEADER_EMAIL]: 'nova@alloyal.com.br' }, '172.18.0.5', {
      ...opts,
      papeisDe: async () => [],
    }),
    /grupo pulse-\* no Google Workspace/,
  )
})

test('faixas CIDR são avaliadas corretamente', () => {
  assert.equal(ipEmFaixa('172.18.0.5', '172.16.0.0/12'), true)
  assert.equal(ipEmFaixa('172.32.0.1', '172.16.0.0/12'), false)
  assert.equal(ipEmFaixa('127.0.0.1', '127.0.0.1/32'), true)
  assert.equal(ipEmFaixa('127.0.0.2', '127.0.0.1/32'), false)
  assert.equal(ipEmFaixa('::ffff:172.18.0.5', '172.16.0.0/12'), true)
  assert.equal(ipEmFaixa('nao-um-ip', '172.16.0.0/12'), false)
})

// ─── Papéis ──────────────────────────────────────────────────────────────────

test('nenhum papel de interface vê dado individual de usuário final', () => {
  for (const papel of PAPEIS) {
    const perm = PERMISSOES[papel]
    if (papel === 'pulse-admin') {
      assert.equal(perm.dadoIndividual, 'auditado')
    } else {
      assert.equal(perm.dadoIndividual, false, `${papel} enxerga dado individual`)
    }
  }
})

test('só o Financeiro aprova distrato por inadimplência', () => {
  const porFinanceiro = PAPEIS.filter((p) => PERMISSOES[p].aprovaDistrato === 'financeiro')
  assert.deepEqual(porFinanceiro, ['pulse-financeiro'])
})

test('permissão de múltiplos grupos é a união, sempre a mais ampla', () => {
  const p = permissoesDe(['pulse-csm', 'pulse-financeiro'])
  assert.equal(p.contas, 'base')
  assert.equal(p.receita, 'base')
  assert.equal(p.aprovaDistrato, 'financeiro')
  assert.equal(p.dadoIndividual, false)
})

test('sem papel nenhum, nada é liberado', () => {
  const p = permissoesDe([])
  assert.equal(p.contas, 'nenhum')
  assert.equal(p.configurar, false)
  assert.equal(p.aprovaDistrato, 'nao')
})

// ─── Magic link ──────────────────────────────────────────────────────────────

const AGORA = new Date('2026-07-26T12:00:00Z')
const base = {
  accountId: '11111111-1111-1111-1111-111111111111',
  email: 'gestor@cliente.com.br',
}

test('o token emitido não é o que se persiste', () => {
  const t = emitirToken(AGORA)
  assert.notEqual(t.token, t.hash)
  assert.equal(t.hash, hashToken(t.token))
  assert.equal(t.hash.length, 64)
})

test('token válido autentica', () => {
  const t = emitirToken(AGORA)
  const r = validarToken(
    { hash: t.hash, ...base, expiraEm: t.expiraEm, usadoEm: null },
    base.email,
    AGORA,
  )
  assert.equal(r.ok, true)
})

test('token expirado é recusado', () => {
  const t = emitirToken(AGORA)
  const depois = new Date(t.expiraEm.getTime() + 1000)
  const r = validarToken(
    { hash: t.hash, ...base, expiraEm: t.expiraEm, usadoEm: null },
    base.email,
    depois,
  )
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.motivo, 'token_expirado')
})

test('token reutilizado é recusado', () => {
  const t = emitirToken(AGORA)
  const r = validarToken(
    { hash: t.hash, ...base, expiraEm: t.expiraEm, usadoEm: AGORA },
    base.email,
    AGORA,
  )
  assert.equal(r.ok === false && r.motivo, 'token_ja_usado')
})

test('link aberto por e-mail diferente é recusado', () => {
  // Cenário real: o gestor encaminha o e-mail para um colega.
  const t = emitirToken(AGORA)
  const r = validarToken(
    { hash: t.hash, ...base, expiraEm: t.expiraEm, usadoEm: null },
    'outro@cliente.com.br',
    AGORA,
  )
  assert.equal(r.ok === false && r.motivo, 'email_divergente')
})

test('e-mail é comparado sem depender de caixa nem de espaço', () => {
  const t = emitirToken(AGORA)
  const r = validarToken(
    { hash: t.hash, ...base, expiraEm: t.expiraEm, usadoEm: null },
    '  Gestor@Cliente.com.BR ',
    AGORA,
  )
  assert.equal(r.ok, true)
})

// ─── A saída de desenvolvimento ──────────────────────────────────────────────

test('a identidade de desenvolvimento é impossível em produção', () => {
  // A pior classe de falha de autenticação: silenciosa, total, e descoberta por
  // terceiros. Nenhuma variável de configuração pode desligar esta checagem.
  assert.equal(permiteIdentidadeDeDesenvolvimento('production', 'invasor@alloyal.com.br'), false)
  assert.equal(permiteIdentidadeDeDesenvolvimento('production', 'qualquer@coisa'), false)
})

test('fora de produção, ela exige a variável explícita', () => {
  assert.equal(permiteIdentidadeDeDesenvolvimento('development', undefined), false)
  assert.equal(permiteIdentidadeDeDesenvolvimento('development', ''), false)
  assert.equal(permiteIdentidadeDeDesenvolvimento(undefined, undefined), false)
  assert.equal(permiteIdentidadeDeDesenvolvimento('development', 'dev@alloyal.com.br'), true)
  assert.equal(permiteIdentidadeDeDesenvolvimento('test', 'dev@alloyal.com.br'), true)
})
