/**
 * Portão do catálogo: todo ajuste declarado é DE FATO lido pelo código.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ É o portão mais importante deste pacote. Um campo na tela de configuração   │
 * │ que não muda comportamento é pior que campo nenhum: ele promete controle    │
 * │ que não existe, e quando o admin mexe e nada acontece, a conclusão dele é   │
 * │ "o produto está quebrado" — não "esse campo é enfeite".                    │
 * │                                                                            │
 * │ Aconteceu na primeira versão deste pacote: 12 ajustes declarados, 1 ligado. │
 * │ As telas ficaram prontas antes da fiação, e sem este teste teriam passado   │
 * │ por revisão inteiras.                                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O teste é frouxo de propósito: confere que a CHAVE aparece no arquivo declarado em
 * `lidoEm`. Não prova que o valor é usado corretamente — isso é trabalho dos testes de
 * comportamento, e há um deles para o teto da fila em `apps/worker/src/fila.test.ts`.
 * O que este portão impede é a categoria óbvia: ajuste que ninguém lê.
 *
 * Roda sem banco.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CATALOGO, POR_GRUPO, SEGREDOS } from './catalogo.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('o catálogo não está vazio', () => {
  assert.ok(CATALOGO.length >= 8, `só ${CATALOGO.length} ajuste(s)`)
  assert.ok(SEGREDOS.length >= 5)
})

test('toda chave é única e no formato que o banco aceita', () => {
  // O CHECK da migration 0016 recusa fora deste formato. Descobrir isso em produção
  // ao gravar seria descobrir tarde.
  const formato = /^[a-z][a-z0-9_.]{2,60}$/
  const vistas = new Set<string>()
  for (const a of CATALOGO) {
    assert.match(a.chave, formato, `${a.chave} não passa no CHECK do banco`)
    assert.equal(vistas.has(a.chave), false, `chave duplicada: ${a.chave}`)
    vistas.add(a.chave)
  }
  for (const s of SEGREDOS) {
    assert.match(s.chave, formato, `${s.chave} não passa no CHECK do banco`)
    assert.equal(vistas.has(s.chave), false, `${s.chave} é ajuste E segredo`)
    vistas.add(s.chave)
  }
})

test('o arquivo declarado em lidoEm existe', () => {
  const ausentes = CATALOGO.filter((a) => !existsSync(join(RAIZ, a.lidoEm))).map(
    (a) => `${a.chave} → ${a.lidoEm}`,
  )
  assert.deepEqual(ausentes, [], `\ncaminho inexistente:\n${ausentes.join('\n')}\n`)
})

test('todo ajuste é LIDO pelo código que diz lê-lo', () => {
  const naoLidos: string[] = []
  for (const a of CATALOGO) {
    const caminho = join(RAIZ, a.lidoEm)
    if (!existsSync(caminho)) continue // o teste acima já acusou
    if (!readFileSync(caminho, 'utf8').includes(a.chave)) {
      naoLidos.push(`${a.chave} não aparece em ${a.lidoEm}`)
    }
  }
  assert.deepEqual(
    naoLidos,
    [],
    `\nAjuste declarado que NINGUÉM lê — o campo na tela seria enfeite:\n${naoLidos.join('\n')}\n\n` +
      'Ou ligue o valor ao comportamento, ou tire do catálogo. Campo que promete controle ' +
      'inexistente faz o admin concluir que o produto está quebrado.\n',
  )
})

test('o portão pega um ajuste não lido', () => {
  // O teste acima passa quando está tudo certo, e passaria também se a detecção
  // estivesse quebrada.
  const inventado = 'fila.chave_que_ninguem_le'
  const arquivo = readFileSync(join(RAIZ, 'apps', 'worker', 'src', 'fila.ts'), 'utf8')
  assert.equal(arquivo.includes(inventado), false, 'a chave de mentira existe no código')
})

test('todo ajuste declara efeito e limites coerentes', () => {
  for (const a of CATALOGO) {
    // Sem a frase de efeito, ninguém mexe (o ajuste não serve) ou alguém mexe sem
    // saber (o ajuste é pior que nada).
    assert.ok(a.efeito.length >= 40, `${a.chave}: efeito curto demais para explicar algo`)
    assert.ok(POR_GRUPO[a.grupo], `${a.chave}: grupo ${a.grupo} não tem rótulo`)

    if (a.tipo === 'booleano') continue
    assert.equal(typeof a.padrao, 'number', `${a.chave}: padrão não é número`)
    const padrao = a.padrao as number
    if (a.minimo !== undefined) {
      assert.ok(padrao >= a.minimo, `${a.chave}: padrão ${padrao} abaixo do próprio mínimo`)
    }
    if (a.maximo !== undefined) {
      assert.ok(padrao <= a.maximo, `${a.chave}: padrão ${padrao} acima do próprio máximo`)
    }
    if (a.minimo !== undefined && a.maximo !== undefined) {
      assert.ok(a.minimo < a.maximo, `${a.chave}: mínimo ${a.minimo} não é menor que máximo`)
    }
  }
})

test('limite que existe por segurança explica o porquê', () => {
  // k-anonimato e teto de fila têm limite que não é preferência: baixá-los publica
  // dado de terceiro ou esvazia a fila do time. A mensagem de recusa carrega o motivo,
  // e sem ele a pessoa tenta de novo às cegas.
  const criticos = ['relatorio.k_minimo_empresas', 'relatorio.k_minimo_pessoas', 'fila.teto_por_pessoa']
  for (const chave of criticos) {
    const a = CATALOGO.find((x) => x.chave === chave)
    assert.ok(a, `${chave} saiu do catálogo`)
    assert.ok(
      (a.porQueOLimite ?? '').length >= 40,
      `${chave}: limite de segurança sem explicação do motivo`,
    )
  }
})

test('segredo cuja falta é irrecuperável diz por quê', () => {
  // "Falta o token" e "cada dia sem o token é histórico que não vai existir" pedem
  // urgências diferentes de quem lê.
  for (const s of SEGREDOS) {
    assert.ok(s.semEle.length >= 20, `${s.chave}: não diz o que deixa de funcionar`)
    assert.ok(s.ondeConseguir.length >= 15, `${s.chave}: não diz onde conseguir`)
    if (s.irrecuperavel !== undefined) {
      assert.ok(s.irrecuperavel.length >= 60, `${s.chave}: "irrecuperável" sem explicar a perda`)
    }
  }
})

test('os dois relógios irrecuperáveis estão declarados como tal', () => {
  // HubSpot (eventos de MRR) e CleverTap (propriedade de conta) são os dois cujo
  // atraso custa histórico que não volta. Se alguém tirar essa marca, o aviso
  // vermelho da tela desaparece junto.
  for (const chave of ['hubspot.token', 'clevertap.account_id']) {
    const s = SEGREDOS.find((x) => x.chave === chave)
    assert.ok(s, `${chave} saiu do catálogo`)
    assert.ok(s.irrecuperavel, `${chave} deixou de ser marcado como perda irrecuperável`)
  }
})
