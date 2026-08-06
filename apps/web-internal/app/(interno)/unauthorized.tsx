import { headers } from 'next/headers'
import { Login } from '@pulse/ui'

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
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ESTA TELA SÓ APARECE PORQUE O PROXY PAROU DE PULAR ELA.                    │
 * │                                                                            │
 * │ Com `--skip-provider-button` e `error_page 401 = /oauth2/start`, quem não  │
 * │ tinha sessão ia direto ao Google e este arquivo NUNCA renderizava — era     │
 * │ desenho morto. O Publi resolve com `--custom-templates-dir`, um `sign_in`   │
 * │ em Go template; a casa paga por isso com DUAS renderizações da mesma tela,  │
 * │ que é a razão de a do Publi e a do Allvoice já terem divergido.             │
 * │                                                                            │
 * │ Aqui o `error_page 401` aponta para `@login`, que traz a requisição sem     │
 * │ identidade até o Next. Uma renderização só, esta.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O que esta tela NÃO diz: nada sobre `PULSE_DEV_EMAIL` nem sobre segredo de proxy. A
 * versão anterior dizia, e era um vazamento de detalhe de deploy para uma tela que
 * fica exposta — quem roda local tem o README, e quem chega aqui em produção só
 * precisa do botão.
 *
 * O `x-pulse-rd` é passado CRU de propósito. Quem filtra é o `BotaoGoogle`, que é
 * quem monta o `href` — ver `rotaInterna`. Filtrar aqui deixaria a próxima página a
 * usar o botão nascer sem a checagem.
 */
export default async function NaoAutenticado() {
  const rd = (await headers()).get('x-pulse-rd')
  return <Login rd={rd} />
}
