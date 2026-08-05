import {
  corDoCliente,
  iniciaisDoCliente,
  kpisDaCarteira,
  mainBusinesses,
  subBusinesses,
  type LinhaDaBase,
} from "@pulse/config";
import { Aviso, Badge, Btn, Card, Field, Kpi, Table } from "@pulse/ui";
import Link from "next/link";

import { Corpo, Topo } from "../../casca";
import { pool } from "../../../../lib/db";
import { exigir, temEscopo } from "../../../../lib/guarda";

export const dynamic = "force-dynamic";

/**
 * A base de clientes que veio do core: main business e sub business.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SEPARADA DA CARTEIRA DE CS, e é decisão: aquela tela ordena por risco ×     │
 * │ receita e responde "onde eu olho hoje". Esta responde "quem é a base", que é │
 * │ uma pergunta de cadastro. Juntar as duas faria uma lista de 1.926 linhas com │
 * │ coluna de risco vazia — pior para as duas perguntas.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A linha abre por URL (`?abrir=<id>`) e não por JavaScript de cliente: a expansão
 * sobrevive a recarregar, pode ser compartilhada por link, e funciona antes de hidratar.
 */

const N = (v: number) => v.toLocaleString("pt-BR");

const CNPJ = (c: string | null) => {
  const d = (c ?? "").replace(/\D/g, "");
  if (d.length !== 14) return c ?? "—";
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
};

/**
 * O monograma no lugar do logo. A API do core não devolve imagem — `banner` existe e é
 * booleano, é flag de módulo. Ver `iniciaisDoCliente`.
 */
function Marca({
  nome,
  chave,
  logo,
}: {
  nome: string;
  chave: string;
  logo: string | null;
}) {
  const h = corDoCliente(chave);
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md text-[11px] font-semibold tracking-tight"
      style={{
        backgroundColor: `hsl(${h} 62% 92%)`,
        color: `hsl(${h} 55% 32%)`,
      }}
    >
      {iniciaisDoCliente(nome)}
      {logo ? (
        // O monograma fica ATRÁS e a imagem por cima: se o logo não carregar, o
        // monograma aparece sozinho — sem JavaScript e sem `onerror`. Fundo branco
        // porque a maioria é SVG desenhado para fundo claro.
        <img
          src={logo}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full bg-white object-contain p-[2px]"
        />
      ) : null}
    </span>
  );
}

/** O rótulo do vínculo com o HubSpot, quando ele diz algo que a pessoa precisa saber. */
const VINCULO: Record<
  string,
  { texto: string; tom: "slate" | "amber" | "indigo" }
> = {
  canal: { texto: "canal", tom: "indigo" },
  interna: { texto: "interna", tom: "slate" },
  historico: { texto: "histórico", tom: "slate" },
  encerrado: { texto: "encerrado", tom: "slate" },
  pendente: { texto: "a decidir", tom: "amber" },
};

function linhaDaTabela(
  l: LinhaDaBase,
  aberta: boolean,
  sub: boolean,
  buscaAtual: string,
) {
  const v = l.hubspotVinculo ? VINCULO[l.hubspotVinculo] : undefined;
  return [
    <div
      key="n"
      className={
        sub ? "flex items-center gap-2 pl-7" : "flex items-center gap-2"
      }
    >
      {!sub && l.subs > 0 ? (
        <Link
          // A seta leva para a MESMA página com o parâmetro trocado — abrir e fechar são
          // a mesma navegação, e o estado mora na URL.
          href={`/carteira/base?${new URLSearchParams({
            ...(buscaAtual ? { q: buscaAtual } : {}),
            ...(aberta ? {} : { abrir: l.id }),
          }).toString()}`}
          aria-label={`${aberta ? "Fechar" : "Abrir"} os ${l.subs} sub business de ${l.razaoSocial}`}
          aria-expanded={aberta}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <span
            className={
              aberta ? "rotate-90 transition-transform" : "transition-transform"
            }
          >
            ›
          </span>
        </Link>
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
      <Marca nome={l.razaoSocial} chave={l.brandId ?? l.id} logo={l.logoUrl} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink">
          {l.razaoSocial}
        </span>
        <span className="block text-[11.5px] text-ink-3">{CNPJ(l.cnpj)}</span>
      </span>
    </div>,
    <span key="b" className="font-mono text-[12.5px] text-ink-2">
      {l.brandId ?? "—"}
    </span>,
    <span key="h" className="font-mono text-[12.5px] text-ink-2">
      {l.hubspotCompanyId ?? "—"}
      {v ? (
        <>
          {" "}
          <Badge tone={v.tom}>{v.texto}</Badge>
        </>
      ) : null}
    </span>,
    <span key="s" className="tabular-nums text-ink-2">
      {l.subs > 0 ? N(l.subs) : "—"}
    </span>,
    <span key="ua" className="tabular-nums text-ink-2">
      {N(l.usuariosAutorizados)}
    </span>,
    <span key="uc" className="tabular-nums text-ink">
      {N(l.usuariosCadastrados)}
      {l.subs > 0 && l.subsUsuariosCadastrados > 0 ? (
        <span className="ml-1 text-[11.5px] text-ink-3">
          +{N(l.subsUsuariosCadastrados)} nos subs
        </span>
      ) : null}
    </span>,
    <Badge key="a" tone={l.ativo ? "green" : "slate"}>
      {l.ativo ? "ativo" : "inativo"}
    </Badge>,
  ];
}

export default async function BaseDeClientes({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    abrir?: string;
    p?: string;
    ativos?: string;
  }>;
}) {
  await exigir((p) => temEscopo(p.contas), "base de clientes");
  const q = await searchParams;
  const busca = (q.q ?? "").trim();
  const pagina = Math.max(Number(q.p ?? "1") || 1, 1);
  const somenteAtivos = q.ativos === "1";

  const db = pool();
  const [kpis, pag] = await Promise.all([
    kpisDaCarteira(db),
    mainBusinesses(db, { busca, pagina, porPagina: 50, somenteAtivos }),
  ]);

  // Só a linha aberta busca os filhos. Carregar os subs de 50 mains a cada render seria
  // 50 consultas para mostrar o que quase ninguém abre.
  const abertaId = q.abrir ?? "";
  const filhos = abertaId ? await subBusinesses(db, abertaId) : [];

  const paginas = Math.max(Math.ceil(pag.total / pag.porPagina), 1);
  const comBusca = (extra: Record<string, string>) =>
    `/carteira/base?${new URLSearchParams({
      ...(busca ? { q: busca } : {}),
      ...(somenteAtivos ? { ativos: "1" } : {}),
      ...extra,
    }).toString()}`;

  const linhas: React.ReactNode[][] = [];
  for (const l of pag.linhas) {
    const aberta = l.id === abertaId;
    linhas.push(linhaDaTabela(l, aberta, false, busca));
    if (aberta)
      for (const f of filhos) linhas.push(linhaDaTabela(f, false, true, busca));
  }

  return (
    <>
      <Topo
        href="/carteira/base"
        titulo="Base de clientes"
        proposito="o cadastro que vem do core, por main business"
      />
      <Corpo>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <Kpi
            rotulo="Clientes total"
            valor={N(kpis.clientesTotal)}
            nota={`${N(kpis.mainBusinesses)} main · ${N(kpis.subBusinesses)} sub · ${N(kpis.comLogo)} logos`}
          />
          <Kpi
            rotulo="Clientes ativos"
            valor={N(kpis.clientesAtivos)}
            nota={`${Math.round((kpis.clientesAtivos / Math.max(kpis.clientesTotal, 1)) * 100)}% da base`}
            tom="green"
          />
          <Kpi
            rotulo="Usuários na base"
            valor={N(kpis.usuariosAutorizados)}
            nota="autorizados a se cadastrar"
          />
          <Kpi
            rotulo="Usuários cadastrados"
            valor={N(kpis.usuariosCadastrados)}
            nota={`${Math.round((kpis.usuariosCadastrados / Math.max(kpis.usuariosAutorizados, 1)) * 100)}% dos autorizados`}
          />
          <Kpi rotulo="Usaram cupom" valor="—" nota="depende do ciclo C1" />
          <Kpi
            rotulo="Cupons resgatados"
            valor="—"
            nota="depende do ciclo C1"
          />
        </div>

        <Aviso tom="alerta">
          <strong className="font-semibold">
            Dois KPIs estão vazios e não é falha de carga.
          </strong>{" "}
          &quot;Usaram cupom&quot; e &quot;Cupons resgatados&quot; não existem
          na API do core — as rotas{" "}
          <code className="font-mono text-[12px]">/coupons</code>,{" "}
          <code className="font-mono text-[12px]">/vouchers</code> e{" "}
          <code className="font-mono text-[12px]">/redemptions</code> respondem
          404 na v3. O dado vem das transações da réplica, pelo ciclo{" "}
          <strong className="font-semibold">C1</strong>, que está declarado e
          não implementado por falta do segredo{" "}
          <code className="font-mono text-[12px]">replica.url</code>. Mostrar
          zero ali diria &quot;ninguém usou cupom&quot;, que é diferente de
          &quot;ainda não medimos&quot;.
        </Aviso>

        <Card
          title={`Main business · ${N(pag.total)}${busca ? " encontrados" : ""}`}
          actions={
            <form action="/carteira/base" className="flex items-center gap-2">
              {/* O campo oculto preserva o filtro de ativos ao buscar. `Field` também
                  serve para ele: o portão do design system recusa `<input>` cru, e a
                  exceção "mas este é hidden" abriria a porta para o próximo. */}
              {somenteAtivos && (
                <Field type="hidden" name="ativos" value="1" readOnly />
              )}
              <Field
                name="q"
                defaultValue={busca}
                placeholder="nome, CNPJ, Business ID ou HubSpot ID"
                aria-label="Buscar cliente"
                className="w-[280px]"
              />
              <Btn type="submit">Buscar</Btn>
              <Link
                href={comBusca(somenteAtivos ? {} : { ativos: "1" })}
                className={
                  somenteAtivos
                    ? "text-[12.5px] font-semibold text-purple-700"
                    : "text-[12.5px] text-ink-3 hover:text-ink"
                }
              >
                {somenteAtivos ? "mostrando só ativos" : "só ativos"}
              </Link>
            </form>
          }
        >
          <Table
            cols={[
              "Cliente",
              "Business ID",
              "HubSpot ID",
              "Subs",
              "Autorizados",
              "Cadastrados",
              "",
            ]}
            rows={linhas}
            vazio={
              busca
                ? `Nada encontrado para "${busca}".`
                : "A base ainda não foi carregada."
            }
          />
          {paginas > 1 && (
            <div className="mt-4 flex items-center justify-between text-[12.5px] text-ink-3">
              <span>
                página {pag.pagina} de {N(paginas)}
              </span>
              <div className="flex gap-3">
                {pag.pagina > 1 && (
                  <Link
                    href={comBusca({ p: String(pag.pagina - 1) })}
                    className="font-semibold text-purple-700 hover:text-purple-500"
                  >
                    ← anterior
                  </Link>
                )}
                {pag.pagina < paginas && (
                  <Link
                    href={comBusca({ p: String(pag.pagina + 1) })}
                    className="font-semibold text-purple-700 hover:text-purple-500"
                  >
                    próxima →
                  </Link>
                )}
              </div>
            </div>
          )}
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            A ordem é por usuários cadastrados, somando os sub business.
            Alfabética poria na primeira página quem tem zero usuário e
            empurraria o maior contrato para a página 30.
            <br />
            <strong className="font-semibold text-ink">Autorizados</strong> é
            quem tem direito de se cadastrar;{" "}
            <strong className="font-semibold text-ink">cadastrados</strong> é
            quem efetivamente criou conta. Nenhum dos dois é &quot;usuário
            ativo&quot; — isso depende do C1.
          </p>
        </Card>
      </Corpo>
    </>
  );
}
