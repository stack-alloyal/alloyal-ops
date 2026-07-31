/**
 * O botão que inicia o fluxo do oauth2-proxy.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Componente de SERVIDOR, e o link é um `<a>` comum — sem JS no caminho.     │
 * │                                                                            │
 * │ A primeira versão era `'use client'` para calcular `rd` (o retorno) a       │
 * │ partir de `window.location`. O resultado: o Next serializou o botão como    │
 * │ referência lazy e o `<a>` NÃO saiu no HTML — a tela de entrar só mostrava   │
 * │ como entrar depois de hidratar. Numa tela de login isso é o defeito mais    │
 * │ caro possível: quem chega com JS lento ou bloqueado não vê porta nenhuma.   │
 * │                                                                            │
 * │ E o `rd` valia menos do que eu supunha. Com o oauth2-proxy à frente         │
 * │ (ADR-016), a requisição não autenticada nem chega ao Next: o proxy          │
 * │ intercepta, autentica e devolve à rota original por conta dele. Esta tela   │
 * │ é o fallback de quando o cabeçalho de identidade não veio — e nesse caso    │
 * │ não existe "rota original" confiável para voltar.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O ícone é o do Google, nas cores oficiais deles — que vivem em `estilo.css` como
 * `.g-azul`/`.g-verde`/`.g-amarelo`/`.g-vermelho`, e não num `fill` aqui. Logotipo de
 * terceiro não pertence ao nosso tema e as regras de marca do Google proíbem
 * repintar, mas abrir exceção na regra "nenhum hex em componente" custaria mais: a
 * regra só é confiável se não tiver exceção.
 */

const IconeGoogle = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path
      className="g-azul"
      d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
    />
    <path
      className="g-verde"
      d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
    />
    <path
      className="g-amarelo"
      d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"
    />
    <path
      className="g-vermelho"
      d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"
    />
  </svg>
)

export function BotaoGoogle({
  rotulo = 'Entrar com Google',
  /** Rota de retorno, quando quem chama sabe qual é. Sem ela o proxy decide. */
  rd,
}: {
  rotulo?: string
  rd?: string
}) {
  const destino = rd ? `/oauth2/start?rd=${encodeURIComponent(rd)}` : '/oauth2/start'

  return (
    <a
      href={destino}
      className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-md border border-line-strong bg-surface px-5 py-3 text-[14.5px] font-semibold text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-100"
    >
      <IconeGoogle />
      {rotulo}
    </a>
  )
}
