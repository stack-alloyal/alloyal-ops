/**
 * A base de clientes vinda do core: main business, sub business e os números da carteira.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A HIERARQUIA JÁ VEM DO CORE e não é inferida aqui: `main_business_id` nulo   │
 * │ é main business; preenchido é sub business, e aponta para o pai. Na base de   │
 * │ 05/08/2026 são 1.926 main, 1.246 sub, e só 221 main têm filho — ou seja, a    │
 * │ maioria esmagadora é conta simples, e a seta de abrir só aparece onde há o    │
 * │ que abrir.                                                                  │
 * │                                                                            │
 * │ SOMAR PAI E FILHO NÃO DUPLICA. Conferido no dado antes de escrever o KPI:     │
 * │ "Ubiz Car (Principal)" tem 4 usuários cadastrados e os 73 filhos somam 89.    │
 * │ Se o pai já contivesse os filhos, o total da carteira sairia dobrado — é o    │
 * │ tipo de erro que ninguém percebe porque o número continua "parecendo certo".  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import type pg from "pg";

export interface KpisDaCarteira {
  readonly clientesTotal: number;
  readonly clientesAtivos: number;
  readonly mainBusinesses: number;
  readonly subBusinesses: number;
  /**
   * `authorized_user_count` do core: a base ELEGÍVEL, quem tem direito de se cadastrar.
   * Não é "usuário ativo" — e chamar de ativo faria a régua de engajamento parecer
   * muito melhor do que é.
   */
  readonly usuariosAutorizados: number;
  /** `user_count` do core: quem efetivamente criou cadastro. */
  readonly usuariosCadastrados: number;
  /**
   * `null` porque o dado NÃO EXISTE ainda, e zero mentiria dizendo "ninguém usou".
   * Vem das transações da réplica (ciclo C1), que depende do segredo `replica.url`.
   */
  readonly usuariosComCupom: number | null;
  readonly cuponsResgatados: number | null;
  /** Quantos clientes já têm logo — a varredura do C19 cobre ~900 por noite. */
  readonly comLogo: number;
}

export async function kpisDaCarteira(db: pg.Pool): Promise<KpisDaCarteira> {
  const { rows } = await db.query<{
    total: string;
    ativos: string;
    mains: string;
    subs: string;
    autorizados: string;
    cadastrados: string;
    com_logo: string;
  }>(
    `SELECT count(*)::text                                             AS total,
            count(*) FILTER (WHERE ativo)::text                        AS ativos,
            count(*) FILTER (WHERE parent_account_id IS NULL)::text     AS mains,
            count(*) FILTER (WHERE parent_account_id IS NOT NULL)::text AS subs,
            coalesce(sum(usuarios_autorizados), 0)::text                AS autorizados,
            coalesce(sum(usuarios_cadastrados), 0)::text                AS cadastrados,
            count(*) FILTER (WHERE logo_url IS NOT NULL)::text          AS com_logo
       FROM core.account`,
  );
  const r = rows[0]!;
  return {
    clientesTotal: Number(r.total),
    clientesAtivos: Number(r.ativos),
    mainBusinesses: Number(r.mains),
    subBusinesses: Number(r.subs),
    usuariosAutorizados: Number(r.autorizados),
    usuariosCadastrados: Number(r.cadastrados),
    // Ver o comentário do tipo: `null` é a resposta honesta enquanto o C1 não roda.
    usuariosComCupom: null,
    cuponsResgatados: null,
    comLogo: Number(r.com_logo),
  };
}

export interface LinhaDaBase {
  readonly id: string;
  readonly brandId: string | null;
  readonly hubspotCompanyId: string | null;
  readonly hubspotVinculo: string | null;
  readonly razaoSocial: string;
  readonly cnpj: string | null;
  readonly ativo: boolean;
  /** URL do logo em `assets.alloyal.com.br`, de "Customização do App" no core. */
  readonly logoUrl: string | null;
  /** De qual campo veio — a resposta para "por que este logo está deitado?". */
  readonly logoOrigem: string | null;
  readonly usuariosAutorizados: number;
  readonly usuariosCadastrados: number;
  /** Quantos sub business pendem deste. Zero significa "não há o que abrir". */
  readonly subs: number;
  /** Soma dos filhos, para o main mostrar o tamanho do grupo sem abrir. */
  readonly subsUsuariosCadastrados: number;
}

export interface PaginaDaBase {
  readonly linhas: LinhaDaBase[];
  readonly total: number;
  readonly pagina: number;
  readonly porPagina: number;
}

const CAMPOS = `
  a.id::text, a.brand_id, a.razao_social, a.cnpj, a.ativo, a.logo_url, a.logo_origem,
  coalesce(a.usuarios_autorizados, 0)::text AS usuarios_autorizados,
  coalesce(a.usuarios_cadastrados, 0)::text AS usuarios_cadastrados,
  h.hubspot_company_id, h.vinculo AS hubspot_vinculo`;

function paraLinha(r: Record<string, unknown>): LinhaDaBase {
  return {
    id: String(r["id"]),
    brandId: (r["brand_id"] as string | null) ?? null,
    hubspotCompanyId: (r["hubspot_company_id"] as string | null) ?? null,
    hubspotVinculo: (r["hubspot_vinculo"] as string | null) ?? null,
    razaoSocial: String(r["razao_social"] ?? ""),
    cnpj: (r["cnpj"] as string | null) ?? null,
    ativo: r["ativo"] === true,
    logoUrl: (r["logo_url"] as string | null) ?? null,
    logoOrigem: (r["logo_origem"] as string | null) ?? null,
    usuariosAutorizados: Number(r["usuarios_autorizados"] ?? 0),
    usuariosCadastrados: Number(r["usuarios_cadastrados"] ?? 0),
    subs: Number(r["subs"] ?? 0),
    subsUsuariosCadastrados: Number(r["subs_cadastrados"] ?? 0),
  };
}

/**
 * Os MAIN business, paginados.
 *
 * A busca cobre nome, CNPJ e os dois ids — é por um deles que a pessoa chega, e obrigar
 * a saber qual campo procurar transforma consulta em adivinhação. O CNPJ é comparado sem
 * pontuação nos dois lados, senão "26.989.697" não encontra "26989697".
 */
export async function mainBusinesses(
  db: pg.Pool,
  opcoes: {
    busca?: string;
    pagina?: number;
    porPagina?: number;
    somenteAtivos?: boolean;
  } = {},
): Promise<PaginaDaBase> {
  const porPagina = Math.min(Math.max(opcoes.porPagina ?? 50, 1), 200);
  const pagina = Math.max(opcoes.pagina ?? 1, 1);
  const busca = (opcoes.busca ?? "").trim();
  const somenteAtivos = opcoes.somenteAtivos === true;

  // $1 = busca, $2 = somenteAtivos. Limite e deslocamento entram DEPOIS, só na
  // consulta paginada — na contagem eles não existem, e parâmetro declarado e não usado
  // faz o Postgres recusar com "could not determine data type of parameter".
  const filtro = `
    a.parent_account_id IS NULL
    AND ($2::boolean IS NOT TRUE OR a.ativo)
    AND ($1::text = '' OR
         a.razao_social ILIKE '%' || $1 || '%' OR
         a.brand_id = $1 OR
         h.hubspot_company_id = $1 OR
         -- ┌───────────────────────────────────────────────────────────────────┐
         -- │ A cláusula de CNPJ EXIGE pelo menos 6 dígitos, e os dois guardas    │
         -- │ vieram de defeito medido:                                          │
         -- │                                                                    │
         -- │ sem o "não vazio", buscar "SWILE" limpava os dígitos para '' e o     │
         -- │ LIKE virava '%%' — casava com TODAS as 1.926 contas, e a busca por   │
         -- │ nome simplesmente não filtrava;                                     │
         -- │                                                                    │
         -- │ sem o mínimo de 6, buscar "912" (um Business ID) trazia junto todo   │
         -- │ CNPJ que contivesse 912 em qualquer posição — 10 resultados para uma │
         -- │ busca exata.                                                       │
         -- └───────────────────────────────────────────────────────────────────┘
         (length(regexp_replace($1, '\\D', '', 'g')) >= 6 AND
          regexp_replace(coalesce(a.cnpj, ''), '\\D', '', 'g')
            LIKE '%' || regexp_replace($1, '\\D', '', 'g') || '%'))`;

  const { rows: cont } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM core.account a
       LEFT JOIN core.account_hubspot h ON h.account_id = a.id
      WHERE ${filtro}`,
    [busca, somenteAtivos],
  );

  const { rows } = await db.query(
    `SELECT ${CAMPOS},
            coalesce(f.n, 0)::text   AS subs,
            coalesce(f.cad, 0)::text AS subs_cadastrados
       FROM core.account a
       LEFT JOIN core.account_hubspot h ON h.account_id = a.id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, coalesce(sum(coalesce(s.usuarios_cadastrados, 0)), 0) AS cad
           FROM core.account s WHERE s.parent_account_id = a.id
       ) f ON true
      WHERE ${filtro}
      -- Maior primeiro: numa lista de 1.926 clientes, ordem alfabética põe na primeira
      -- página quem tem 0 usuário e empurra o maior contrato para a página 30.
      ORDER BY (coalesce(a.usuarios_cadastrados, 0) + coalesce(f.cad, 0)) DESC,
               a.razao_social ASC
      LIMIT $3 OFFSET $4`,
    [busca, somenteAtivos, porPagina, (pagina - 1) * porPagina],
  );

  return {
    linhas: rows.map((r) => paraLinha(r as Record<string, unknown>)),
    total: Number(cont[0]?.n ?? 0),
    pagina,
    porPagina,
  };
}

/** Os sub business de UM main. Usado quando a linha é aberta. */
export async function subBusinesses(
  db: pg.Pool,
  mainId: string,
): Promise<LinhaDaBase[]> {
  const { rows } = await db.query(
    `SELECT ${CAMPOS}, 0 AS subs, 0 AS subs_cadastrados
       FROM core.account a
       LEFT JOIN core.account_hubspot h ON h.account_id = a.id
      WHERE a.parent_account_id = $1::uuid
      ORDER BY coalesce(a.usuarios_cadastrados, 0) DESC, a.razao_social ASC`,
    [mainId],
  );
  return rows.map((r) => paraLinha(r as Record<string, unknown>));
}

/**
 * As iniciais que viram a marca do cliente na lista.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NÃO HÁ LOGO NA API DO CORE. Conferido nos 49 campos que `/businesses`        │
 * │ devolve: `banner` existe e é BOOLEANO — é flag de módulo, não imagem. Buscar  │
 * │ logo por domínio num serviço de favicon foi descartado por duas razões: a CSP │
 * │ da aplicação bloqueia imagem de terceiro, e o resultado seria o logo de quem  │
 * │ tem o domínio parecido — errado com cara de certo.                          │
 * │                                                                            │
 * │ Monograma é honesto: identifica sem afirmar nada que não sabemos.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function iniciaisDoCliente(razaoSocial: string): string {
  const limpo = razaoSocial
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim();
  const partes = limpo
    .split(/\s+/)
    .filter((p) => p.length > 1 && !/^(de|da|do|e|ltda|me|sa)$/i.test(p));
  const escolhidas =
    partes.length > 0 ? partes : limpo.split(/\s+/).filter(Boolean);
  const letras = escolhidas.slice(0, 2).map((p) => p[0]!.toUpperCase());
  return letras.join("") || "?";
}

/**
 * A cor do monograma, derivada do id — estável entre cargas e entre telas.
 *
 * Determinística de propósito: cor sorteada faria o mesmo cliente mudar de cor a cada
 * render, e a pessoa perde a referência visual que a cor existe para dar.
 */
export function corDoCliente(chave: string): number {
  let h = 0;
  for (let i = 0; i < chave.length; i++)
    h = (h * 31 + chave.charCodeAt(i)) % 360;
  return h;
}
