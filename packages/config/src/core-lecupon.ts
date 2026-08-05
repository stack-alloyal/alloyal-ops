/**
 * Cliente da API do core da Alloyal (Lecupon v3) — cadastro de cliente.
 *
 * Decisão em `docs/adr-018-dados-de-cliente-e-o-allvoice.md`: o Pulse consome a
 * MESMA API que o Allvoice consome. Nenhum dos dois é dono; os dois são leitores.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TRÊS COISAS MEDIDAS NA API REAL, em 04/08/2026, e cada uma muda o desenho: │
 * │                                                                            │
 * │ 1. A PÁGINA É FIXA EM 30 e `per_page` é IGNORADO. Testado com 30, 100 e     │
 * │    200 — sempre 30. Uma base de ~3.245 clientes são ~108 requisições por    │
 * │    carga cheia, e é isso que faz a cadência ser diária e não de minutos.    │
 * │                                                                            │
 * │ 2. NÃO HÁ FILTRO POR DATA DE ATUALIZAÇÃO. Sem ele não existe carga          │
 * │    incremental de verdade — só carga cheia comparada com o que já está      │
 * │    gravado. O ciclo grava apenas o que MUDOU, mas precisa ler tudo.         │
 * │                                                                            │
 * │ 3. Os cabeçalhos têm grafia própria: `X-ClientEmployee-Token`, e não        │
 * │    `X-Client-Employee-Token`. Errar isso dá 401 com "Acesso negado" — que   │
 * │    parece credencial inválida e não é. Custou uma rodada aqui.              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** O que a API devolve por cliente, do que interessa ao Pulse. */
export interface NegocioDoCore {
  readonly id: number;
  readonly name: string;
  readonly cnpj: string | null;
  readonly hubspot_company_id: string | number | null;
  readonly main_business_id: number | null;
  readonly active: boolean;
  readonly status: string | null;
  readonly user_count: number | null;
  readonly authorized_user_count: number | null;
  readonly contact_email: string | null;
  /** As flags de módulo vêm soltas no mesmo objeto. */
  readonly [outro: string]: unknown;
}

export interface CredencialDoCore {
  readonly base: string;
  readonly token: string;
  readonly email: string;
  readonly tenantCnpj?: string;
}

export function credencialDoAmbiente(
  env: NodeJS.ProcessEnv,
): CredencialDoCore | null {
  const token = (env["LECUPON_CLIENT_EMPLOYEE_TOKEN"] ?? "").trim();
  const email = (env["LECUPON_CLIENT_EMPLOYEE_EMAIL"] ?? "").trim();
  if (!token || !email) return null;
  const base = (
    env["LECUPON_API_BASE"] ?? "https://api.lecupon.com/client/v3"
  ).replace(/\/$/, "");
  const tenant = (env["LECUPON_TENANT_CNPJ"] ?? "").replace(/\D/g, "");
  // `exactOptionalPropertyTypes` recusa `tenantCnpj: undefined` numa propriedade
  // opcional: ausente e presente-como-undefined são coisas diferentes para o tipo.
  return tenant
    ? { base, token, email, tenantCnpj: tenant }
    : { base, token, email };
}

/**
 * Os cabeçalhos, na grafia que a API aceita.
 *
 * Pura e exportada porque é onde o erro mora e onde ele não custa nada para
 * testar: `X-Client-Employee-Token` (com o hífen a mais) devolve 401 "Acesso
 * negado", indistinguível de token errado.
 */
export function cabecalhos(c: CredencialDoCore): Record<string, string> {
  return {
    "X-ClientEmployee-Token": c.token,
    "X-ClientEmployee-Email": c.email,
    "Tenant-id": c.tenantCnpj ?? "",
    Accept: "application/json",
  };
}

/** O corpo vem como array ou dentro de envelope, dependendo da rota. */
export function extrairLista(corpo: unknown): NegocioDoCore[] {
  if (Array.isArray(corpo)) return corpo as NegocioDoCore[];
  if (corpo && typeof corpo === "object") {
    for (const chave of ["businesses", "data", "items"]) {
      const v = (corpo as Record<string, unknown>)[chave];
      if (Array.isArray(v)) return v as NegocioDoCore[];
    }
  }
  return [];
}

/**
 * As flags de módulo, extraídas do objeto solto.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LISTA NEGATIVA, e não positiva — e a escolha é o ponto todo.                │
 * │                                                                            │
 * │ Com lista positiva ("estes são os módulos"), um módulo novo do core NÃO     │
 * │ apareceria, e sem erro nenhum: a tela mostraria a configuração incompleta   │
 * │ como se estivesse completa. Com lista negativa, módulo novo entra sozinho   │
 * │ na próxima carga — o custo é o inverso, um campo booleano que não é módulo  │
 * │ aparecer como se fosse, e isso alguém VÊ na tela.                          │
 * │                                                                            │
 * │ Errar para o lado visível é melhor que errar para o lado silencioso.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const NAO_SAO_MODULO = new Set([
  "active",
  "allow_registration",
  "biometry",
  "must_approve_organization",
  "sync_user_updates",
  "push_notification_enabled",
  "user_request_withdrawal",
  "cashback_manage",
  "cashback_requestable_amount",
  "cashback_transfer_receiver",
  "cashback_wallet_destination",
  "organization_manage",
  "mail_invite",
]);

export function modulosDe(
  n: NegocioDoCore,
): { modulo: string; ativo: boolean }[] {
  const saida: { modulo: string; ativo: boolean }[] = [];
  for (const [chave, valor] of Object.entries(n)) {
    if (typeof valor !== "boolean") continue;
    if (NAO_SAO_MODULO.has(chave)) continue;
    saida.push({ modulo: chave, ativo: valor });
  }
  return saida.sort((a, b) => a.modulo.localeCompare(b.modulo));
}

/** Só dígitos. `null` quando não sobra nada — CNPJ vazio não é CNPJ. */
export function cnpjNormalizado(
  bruto: string | null | undefined,
): string | null {
  const d = (bruto ?? "").replace(/\D/g, "");
  return d.length ? d : null;
}

export class CoreIndisponivelError extends Error {
  readonly status: number;
  constructor(status: number, corpo: string) {
    super(`API do core respondeu ${status}: ${corpo.slice(0, 200)}`);
    this.name = "CoreIndisponivelError";
    this.status = status;
  }
}

export interface OpcoesDeLeitura {
  /**
   * Teto de páginas. Existe para o ciclo não virar varredura infinita se a API
   * passar a devolver sempre página cheia — que é como um defeito do lado deles
   * se transformaria em milhares de requisições do nosso lado.
   */
  readonly maxPaginas?: number;
  /** Pausa entre páginas. O Allvoice trata volume de chamada como risco de DoS. */
  readonly pausaMs?: number;
  readonly log?: (msg: string) => void;
  readonly buscar?: typeof fetch;
}

/**
 * Lê a base inteira, paginando.
 *
 * Devolve `parcial: true` quando parou pelo teto de páginas: o ciclo precisa saber
 * a diferença entre "li tudo" e "li o que deu", porque a segunda NÃO autoriza
 * apagar o que não veio.
 */
export async function lerNegocios(
  c: CredencialDoCore,
  opts: OpcoesDeLeitura = {},
): Promise<{ negocios: NegocioDoCore[]; paginas: number; parcial: boolean }> {
  const buscar = opts.buscar ?? fetch;
  const maxPaginas = opts.maxPaginas ?? 200;
  const pausa = opts.pausaMs ?? 120;
  const negocios: NegocioDoCore[] = [];
  const vistos = new Set<number>();
  let pagina = 1;

  for (; pagina <= maxPaginas; pagina++) {
    const resp = await buscar(
      `${c.base}/businesses?page=${pagina}&per_page=30`,
      {
        headers: cabecalhos(c),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!resp.ok)
      throw new CoreIndisponivelError(resp.status, await resp.text());

    const lista = extrairLista(await resp.json());
    if (lista.length === 0)
      return { negocios, paginas: pagina - 1, parcial: false };

    let novos = 0;
    for (const n of lista) {
      // Dedup por id: se a paginação da API repetir (mudança de ordem entre
      // páginas, que acontece quando alguém edita durante a varredura), sem isto o
      // mesmo cliente entra duas vezes e o upsert briga consigo mesmo.
      if (vistos.has(n.id)) continue;
      vistos.add(n.id);
      negocios.push(n);
      novos++;
    }
    opts.log?.(`página ${pagina}: ${lista.length} lidos, ${novos} novos`);

    // Página incompleta é o fim. `< 30` e não `< lista.length`: o tamanho é fixo.
    if (lista.length < 30) return { negocios, paginas: pagina, parcial: false };
    if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
  }

  opts.log?.(`PARADO no teto de ${maxPaginas} páginas — leitura PARCIAL`);
  return { negocios, paginas: maxPaginas, parcial: true };
}

/**
 * O logo do cliente, de `/businesses/:id/business_app`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ESTE ENDPOINT DEVOLVE SEGREDO. Conferido na resposta real: `api_key`,        │
 * │ `api_secret`, `clever_tap_passcode`, `facebook_sdk_client_token`,            │
 * │ `inngage_token` e mais. Por isso a leitura é por LISTA EXPLÍCITA de campos de │
 * │ imagem — nunca um spread do objeto. Guardar a resposta inteira "porque pode   │
 * │ ser útil depois" colocaria segredo de cliente numa tabela que a tela lê.      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A ORDEM é a que o usuário pediu: Logo Vertical colorida primeiro, favicon depois. As
 * outras entram só como último recurso, e o campo de origem fica gravado para a tela
 * poder dizer de onde veio quando o logo parecer errado.
 */
export const CAMPOS_DE_LOGO = [
  "vertical_logo_url",
  "favicon_url",
  "svg_logo_url",
  "horizontal_logo_url",
  "logo_url",
  "logo_large_url",
  "email_logo_url",
] as const;

export interface LogoDoApp {
  readonly url: string;
  /** Qual campo respondeu. Sem isto, "por que o logo está deitado?" não tem resposta. */
  readonly origem: string;
}

/** Pura e exportada: a escolha do campo é a regra, e ela se testa sem rede. */
export function escolherLogo(corpo: Record<string, unknown>): LogoDoApp | null {
  for (const campo of CAMPOS_DE_LOGO) {
    const v = corpo[campo];
    if (typeof v !== "string") continue;
    const url = v.trim();
    // Só https, e só o host de imagem da Alloyal: é o que a CSP permite, e gravar uma
    // URL que a tela não pode carregar é um logo quebrado com cara de logo.
    if (/^https:\/\/assets\.alloyal\.com\.br\//.test(url))
      return { url, origem: campo };
  }
  return null;
}

export async function lerLogoDoApp(
  cred: CredencialDoCore,
  brandId: string,
  buscar: typeof fetch = fetch,
): Promise<LogoDoApp | null> {
  const r = await buscar(
    `${cred.base}/businesses/${encodeURIComponent(brandId)}/business_app`,
    {
      headers: cabecalhos(cred),
    },
  );
  if (!r.ok) return null;
  const corpo: unknown = await r.json();
  if (corpo === null || typeof corpo !== "object") return null;
  return escolherLogo(corpo as Record<string, unknown>);
}
