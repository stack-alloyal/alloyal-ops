import { Login } from '@ops/ui'

/**
 * 401 — não autenticado. É a tela de login.
 *
 * `unauthorized()` do Next renderiza este arquivo, então a porta de entrada do
 * produto e a resposta a "sessão expirou" são a MESMA tela. Isso é de propósito: as
 * duas situações têm a mesma saída — entrar com o Google — e duas telas diferentes
 * para a mesma ação dariam a impressão de que uma delas é um erro.
 *
 * A composição é a do Allvoice (Hub): painel de marca escuro à esquerda, entrada à
 * direita. Quem trabalha nos dois produtos reconhece a porta.
 *
 * O que esta tela NÃO diz: nada sobre `OPS_DEV_EMAIL` nem sobre segredo de proxy. A
 * versão anterior dizia, e era um vazamento de detalhe de deploy para uma tela que
 * fica exposta — quem roda local tem o README, e quem chega aqui em produção só
 * precisa do botão.
 */
export default function NaoAutenticado() {
  return <Login />
}
