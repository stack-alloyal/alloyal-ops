/**
 * Filtra a rota de retorno que veio de fora antes de ela virar destino.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE ISTO EXISTE:                                                       │
 * │                                                                            │
 * │ O `rd` da tela de login nasce do `$request_uri` — o caminho que o VISITANTE │
 * │ pediu. Um valor escolhido por quem não está autenticado vira o `href` de um │
 * │ botão que a vítima clica. Sem filtro isso é redirecionamento aberto: a tela │
 * │ de login do domínio da casa mandando o usuário para fora dele, logo depois  │
 * │ de ele digitar a senha do Google.                                          │
 * │                                                                            │
 * │ O filtro fica AQUI, no componente que monta o `href`, e não em quem chama:  │
 * │ um `rd` só chega ao navegador passando por esta função. Se a checagem       │
 * │ morasse na página, a próxima página a usar o botão nasceria sem ela.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function rotaInterna(bruto: string | null | undefined): string | undefined {
  if (!bruto) return undefined

  // Uma barra, e só uma. `//evil.com` é URL absoluta protocolo-relativa para o
  // navegador, e `/\evil.com` também — o Chrome e o Firefox tratam a barra
  // invertida como barra ao interpretar autoridade. As duas SAEM do domínio
  // parecendo caminho interno, que é o motivo de a checagem ingênua
  // `startsWith('/')` não bastar.
  if (!bruto.startsWith('/')) return undefined
  if (bruto.startsWith('//') || bruto.startsWith('/\\')) return undefined

  // Espaço, tab, nova linha e caracteres de controle: quebram o cabeçalho na ida
  // e a URL na volta — nova linha em cabeçalho é injeção de resposta. A checagem
  // é por código, e não por classe de regex com faixa literal: escrever
  // `[\x00-\x20\x7f]` já colocou bytes NUL de verdade neste arquivo uma vez.
  for (const caractere of bruto) {
    const codigo = caractere.codePointAt(0) ?? 0
    if (codigo <= 0x20 || codigo === 0x7f) return undefined
  }

  // Voltar para dentro do próprio fluxo de autenticação é laço: o retorno
  // dispararia o login de novo.
  if (bruto === '/' || bruto.startsWith('/oauth2/')) return undefined

  return bruto
}
