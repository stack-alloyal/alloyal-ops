/**
 * Cabeçalhos de segurança das duas aplicações.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O pen test achou ZERO cabeçalho de segurança nas respostas. `Cache-Control` │
 * │ estava certo (`private, no-store`), mas não havia CSP, `frame-ancestors`,   │
 * │ HSTS, `X-Content-Type-Options` nem `Referrer-Policy`.                      │
 * │                                                                            │
 * │ `frame-ancestors` é BLOQUEANTE no critério de lançamento do portal (§17.3): │
 * │ sem ele, qualquer site embute o portal num iframe invisível e captura       │
 * │ clique — e o cliente estaria autenticado enquanto isso acontece.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Compartilhado entre as duas apps por um motivo: cabeçalho de segurança copiado
 * diverge, e a app que ficar atrás vai ser a que ninguém testou. Aqui a diferença
 * entre interna e portal é um PARÂMETRO, não um segundo arquivo.
 */

/**
 * @param {object} opts
 * @param {string[]} opts.frameAncestors Quem pode embutir. `["'none'"]` para ninguém.
 * @param {boolean} [opts.hsts] Só faça `true` quando o domínio for HTTPS de verdade —
 *   HSTS num host que atende HTTP trava o navegador do time num redirect que não existe.
 */
export function cabecalhosDeSeguranca({ frameAncestors, hsts = true }) {
  const csp = [
    "default-src 'self'",
    // `unsafe-inline` em script é exigência do Next: ele injeta script inline para
    // hidratação e streaming de RSC. Sem nonce por requisição não há como remover, e
    // nonce exige middleware em toda rota — troca que só compensa com conteúdo de
    // terceiro na página, que aqui não existe.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    // `data:` por causa do favicon e de SVG embutido. Sem host externo: o artefato
    // que sai daqui não pode depender de CDN, e imagem remota é canal de exfiltração.
    // `assets.alloyal.com.br` é o host de imagem da PRÓPRIA Alloyal, e entra só para o
    // logo do cliente vindo do core (campo `vertical_logo_url` / `favicon_url` de
    // `/businesses/:id/business_app`). Foi preferido a baixar e servir de dentro por um
    // motivo prosaico: 3.172 downloads diários e ~60 MB guardados para mostrar um
    // quadradinho de 28 px é custo sem retorno. Nenhum outro host de terceiro entra —
    // um `img-src *` transformaria qualquer campo de texto num vazamento de referer.
    "img-src 'self' data: https://assets.alloyal.com.br",
    "font-src 'self' data:",
    // Nenhum destino externo de rede. Se um dia houver, entra aqui NOMEADO.
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors.join(" ")}`,
    "upgrade-insecure-requests",
  ].join("; ");

  return [
    { key: "Content-Security-Policy", value: csp },
    // Redundante com `frame-ancestors` para navegador antigo que ignora CSP.
    {
      key: "X-Frame-Options",
      value: frameAncestors.includes("'none'") ? "DENY" : "SAMEORIGIN",
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // `strict-origin-when-cross-origin` ainda manda a origem; aqui a URL carrega id de
    // conta e de relatório, então não vaza nem a origem.
    { key: "Referrer-Policy", value: "no-referrer" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ...(hsts
      ? [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ]
      : []),
  ];
}
