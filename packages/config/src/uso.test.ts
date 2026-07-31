/**
 * A sonda de conexão, e o que ela precisa NÃO confundir.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Estes testes existem por dois defeitos que só apareceram rodando contra as  │
 * │ APIs de verdade — o desenho dos três estados estava certo e a CLASSIFICAÇÃO  │
 * │ das respostas reais estava errada em dois de três casos:                     │
 * │                                                                            │
 * │   O CleverTap devolve 400 para Account ID malformado, e eu classifiquei como │
 * │   "indisponível" — dizendo ao operador "espere" quando a ação é "confira o   │
 * │   valor". É exatamente o erro que os três estados existem para evitar.       │
 * │                                                                            │
 * │   O Omie devolveu 403 e minha mensagem afirmava "respondeu 200", porque o    │
 * │   texto estava cravado em vez de usar o status observado. Diagnóstico que    │
 * │   mente sobre o que aconteceu é pior que diagnóstico ausente.                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Os testes de classificação são puros: exercitam o mapeamento status→estado sem
 * chamar ninguém. Sonda contra API de terceiro em CI seria teste que falha quando o
 * fornecedor tem um dia ruim, e teste assim é o primeiro a ser ignorado.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  INTEGRACAO_DA_CHAVE,
  INTEGRACOES_SONDAVEIS,
  classificarClevertap,
  classificarHubspot,
  classificarOmie,
} from './uso.js'
import { SEGREDOS } from './catalogo.js'

test('toda integração sondável tem pelo menos um segredo no catálogo', () => {
  for (const i of INTEGRACOES_SONDAVEIS) {
    const chaves = SEGREDOS.filter((s) => INTEGRACAO_DA_CHAVE[s.chave] === i)
    assert.ok(chaves.length > 0, `${i} é sondável e não tem segredo declarado`)
  }
})

test('toda chave mapeada existe no catálogo de segredos', () => {
  // Sem isto, o botão da tela mostra "0/0" para uma integração cuja chave foi
  // renomeada — e "0 de 0 cadastrados" se lê como "não precisa de nada".
  const doCatalogo = new Set(SEGREDOS.map((s) => s.chave))
  const orfas = Object.keys(INTEGRACAO_DA_CHAVE).filter((c) => !doCatalogo.has(c))
  assert.deepEqual(orfas, [], `chaves mapeadas que não estão no catálogo: ${orfas.join(', ')}`)
})

test('todo segredo de integração sondável está mapeado', () => {
  // O inverso: um segredo novo do HubSpot sem entrada no mapa faria o contador da
  // tela dizer 1/1 quando faltam dois.
  const naoMapeados = SEGREDOS.filter(
    (s) =>
      /^(hubspot|clevertap|omie)\./.test(s.chave) && INTEGRACAO_DA_CHAVE[s.chave] === undefined,
  ).map((s) => s.chave)
  assert.deepEqual(naoMapeados, [])
})

/**
 * A tabela de classificação, extraída do que as APIs REALMENTE responderam.
 *
 * Cada linha veio de uma execução contra a API do fornecedor, não de documentação: a
 * documentação do Omie não diz que ele devolve 200 recusando, e a do CleverTap não
 * distingue 400 de 401.
 */
const CLASSIFICACAO: readonly {
  integracao: string
  status: number
  corpo?: string
  esperado: string
  porque: string
}[] = [
  { integracao: 'hubspot', status: 200, esperado: 'ok', porque: 'token válido com escopo' },
  {
    integracao: 'hubspot',
    status: 401,
    esperado: 'credencial_recusada',
    porque: 'token expirado, revogado ou colado incompleto',
  },
  {
    integracao: 'hubspot',
    status: 403,
    esperado: 'credencial_recusada',
    porque: 'token válido SEM escopo — trocar o token não resolve',
  },
  {
    integracao: 'hubspot',
    status: 429,
    esperado: 'indisponivel',
    porque: 'limite de taxa: o token pode estar certo',
  },
  {
    integracao: 'clevertap',
    status: 400,
    esperado: 'credencial_recusada',
    porque: 'Account ID malformado — foi o defeito real desta sonda',
  },
  { integracao: 'clevertap', status: 401, esperado: 'credencial_recusada', porque: 'passcode errado' },
  {
    integracao: 'omie',
    status: 200,
    corpo: '{"faultstring":"A chave de acesso n\\u00e3o \\u00e9 v\\u00e1lida."}',
    esperado: 'credencial_recusada',
    porque: 'o Omie recusa com 200 e erro no corpo',
  },
  {
    integracao: 'omie',
    status: 403,
    corpo: '{"faultstring":"A chave de acesso não está preenchida."}',
    esperado: 'credencial_recusada',
    porque: 'foi o status real observado, apesar da doc sugerir 200',
  },
  {
    integracao: 'omie',
    status: 200,
    corpo: '{"clientes_cadastro_resumido":[]}',
    esperado: 'ok',
    porque: '200 sem faultstring é sucesso de verdade',
  },
]

test('cada resposta observada cai no estado certo — exercendo a função, não a tabela', () => {
  // A primeira versão deste arquivo verificava a TABELA acima e nada mais: passaria
  // com a classificação quebrada de novo. Aqui a função é chamada.
  for (const c of CLASSIFICACAO) {
    const d =
      c.integracao === 'hubspot'
        ? classificarHubspot(c.status)
        : c.integracao === 'clevertap'
          ? classificarClevertap(c.status, 'us1')
          : classificarOmie(c.status, c.corpo ?? '')
    assert.equal(
      d.estado,
      c.esperado,
      `${c.integracao} ${c.status} → ${d.estado}, esperado ${c.esperado} (${c.porque})`,
    )
  }
})

test('o 400 do CleverTap é credencial, não indisponibilidade', () => {
  // O defeito real, com portão próprio: classificar 400 como problema do fornecedor
  // manda o operador esperar quando a ação é conferir o Account ID.
  const d = classificarClevertap(400, 'us1')
  assert.equal(d.estado, 'credencial_recusada')
  assert.match(d.diagnostico, /Account ID/)
  assert.equal(/tente em alguns minutos|instabilidade/i.test(d.diagnostico), false)
})

test('a mensagem do Omie usa o status OBSERVADO, nunca um 200 cravado', () => {
  // O outro defeito real: o texto afirmava "respondeu 200" enquanto o status era 403.
  const d = classificarOmie(403, '{"faultstring":"A chave de acesso não é válida."}')
  assert.equal(d.estado, 'credencial_recusada')
  assert.match(d.diagnostico, /HTTP 403/)
  assert.equal(/respondeu 200 com erro/.test(d.diagnostico), false, 'voltou a cravar 200')
})

test('o Omie com 200 e faultstring é recusa, não sucesso', () => {
  // Olhar só o status diria "ok" para uma chave errada.
  const d = classificarOmie(200, '{"faultstring":"Chave inválida"}')
  assert.equal(d.estado, 'credencial_recusada')
})

test('o unicode escapado do Omie chega legível', () => {
  const d = classificarOmie(403, '{"faultstring":"A chave n\\u00e3o \\u00e9 v\\u00e1lida."}')
  assert.match(d.diagnostico, /não é válida/)
  assert.equal(d.diagnostico.includes('u00e3'), false, 'escape cru foi para a tela')
})

test('403 do HubSpot NÃO manda trocar o token', () => {
  // 403 é token válido sem escopo. Mandar trocar faria a pessoa gerar um token novo
  // com o mesmo escopo faltando, e concluir que o produto está quebrado.
  const d = classificarHubspot(403)
  assert.equal(d.estado, 'credencial_recusada')
  assert.match(d.diagnostico, /Não troque o token/)
  assert.match(d.diagnostico, /crm\.objects\.deals\.read/)
})

test('nenhuma classificação de credencial recusada manda esperar', () => {
  // "credencial_recusada" e "indisponivel" pedem ações opostas.
  const recusas = [
    classificarHubspot(401),
    classificarHubspot(403),
    classificarClevertap(400, 'us1'),
    classificarClevertap(401, 'us1'),
    classificarOmie(200, '{"faultstring":"x"}'),
  ]
  for (const d of recusas) {
    assert.equal(d.estado, 'credencial_recusada')
    assert.equal(
      /tente em alguns minutos|aguarde|instabilidade/i.test(d.diagnostico),
      false,
      `diagnóstico de credencial sugere esperar: ${d.diagnostico}`,
    )
  }
})

test('indisponibilidade NÃO manda trocar credencial', () => {
  // O inverso: 429 é limite de taxa, e trocar o token não resolve nada.
  const d = classificarHubspot(429)
  assert.equal(d.estado, 'indisponivel')
  assert.match(d.diagnostico, /token pode estar certo/)
})
