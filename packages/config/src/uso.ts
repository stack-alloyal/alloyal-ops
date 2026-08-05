import {
  cifradoComAChaveAtual,
  cifrar,
  decifrar,
  type Identidade,
} from "@pulse/auth";
import type pg from "pg";

import { credencialDoAmbiente, type CredencialDoCore } from "./core-lecupon.js";

/**
 * O lado do USO dos segredos: decifrar e marcar que foi usado.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Existe porque eu havia construído metade do fluxo. `cifrar` tinha chamador  │
 * │ (a tela), `decifrar` não tinha nenhum, e `ops.segredo.usado_em` nunca era   │
 * │ escrito. A consequência não era só código morto: a tela dizia "nunca usado  │
 * │ por nenhum ciclo", o que INSINUA que um ciclo escreveria ali — e nenhum     │
 * │ escrevia. Um campo que nunca muda de valor mente sobre o que mede.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Quem chama isto é o worker, com o role `pulse_worker` — o único que tem `SELECT` em
 * `ops.segredo`. A tela (`pulse_api`) não tem, de propósito.
 */

export class SegredoAusenteError extends Error {
  constructor(chave: string, oQueDeixaDeFuncionar: string) {
    // A mensagem é escrita em log de ciclo e lida por quem está de plantão. Dizer
    // "segredo ausente" mandaria a pessoa procurar onde; dizer a chave e a tela
    // resolve sem ela abrir o código.
    super(
      `segredo "${chave}" não está cadastrado — ${oQueDeixaDeFuncionar}. ` +
        "Cadastre em Configurações → Segredos.",
    );
    this.name = "SegredoAusenteError";
  }
}

/**
 * Devolve o segredo em claro e marca `usado_em`.
 *
 * A marca é gravada ANTES de o valor ser devolvido, e fora de qualquer transação do
 * chamador: se o ciclo falhar depois, ainda é verdade que o segredo foi lido. Registrar
 * só em caso de sucesso faria "nunca usado" significar duas coisas — nunca lido, ou
 * lido e a integração quebrou — e são conversas diferentes.
 */
export async function usarSegredo(
  db: pg.Pool,
  chave: string,
  oQueDeixaDeFuncionar = "a integração que depende dele não roda",
): Promise<string> {
  const { rows } = await db.query<{ valor_cifrado: string }>(
    `UPDATE ops.segredo SET usado_em = now() WHERE chave = $1 RETURNING valor_cifrado`,
    [chave],
  );
  const guardado = rows[0]?.valor_cifrado;
  if (!guardado) throw new SegredoAusenteError(chave, oQueDeixaDeFuncionar);
  // `decifrar` lança `SegredoCorrompidoError` com mensagem que NÃO contém o valor —
  // pode subir para o log do ciclo como está.
  return decifrar(guardado);
}

/** Existe, sem decifrar nem marcar uso. Para o ciclo decidir se vale tentar. */
export async function segredoExiste(
  db: pg.Pool,
  chave: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM ops.segredo WHERE chave = $1",
    [chave],
  );
  return rowCount === 1;
}

/**
 * A credencial do core, do BANCO primeiro e do ambiente como reserva.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE ISTO EXISTE: a tela de Segredos grava em `ops.segredo` cifrado, e até │
 * │ aqui NENHUM ciclo lia de lá — `usarSegredo` não tinha um único chamador. O    │
 * │ C18 lia só de `process.env`. Quem cadastrasse a credencial pela tela veria     │
 * │ "salvo" e o ciclo seguiria inerte, sem nada explicar a contradição.           │
 * │                                                                            │
 * │ Fica aqui, e não em `core-lecupon.ts`, porque aquele arquivo é cliente puro   │
 * │ de API: o teste dele não abre banco, e é o que o mantém rápido e honesto.     │
 * │                                                                            │
 * │ Banco antes de ambiente é a ordem certa: o banco é onde a operação mexe, o    │
 * │ env é onde o dev mexe. E `usarSegredo` marca `usado_em`, que é o que faz a     │
 * │ tela poder dizer com verdade quando um ciclo usou a credencial.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function credencialDoCore(
  db: pg.Pool,
  env: NodeJS.ProcessEnv,
): Promise<CredencialDoCore | null> {
  const [temToken, temEmail] = await Promise.all([
    segredoExiste(db, "lecupon.employee_token"),
    segredoExiste(db, "lecupon.employee_email"),
  ]);
  if (temToken && temEmail) {
    const semEle = "o C18 não lê o cadastro de cliente do core";
    const token = (
      await usarSegredo(db, "lecupon.employee_token", semEle)
    ).trim();
    const email = (
      await usarSegredo(db, "lecupon.employee_email", semEle)
    ).trim();
    const tenant = (await segredoExiste(db, "lecupon.tenant_cnpj"))
      ? (await usarSegredo(db, "lecupon.tenant_cnpj")).replace(/\D/g, "")
      : "";
    if (token && email) {
      const base = (
        env["LECUPON_API_BASE"] ?? "https://api.lecupon.com/client/v3"
      ).replace(/\/$/, "");
      return tenant
        ? { base, token, email, tenantCnpj: tenant }
        : { base, token, email };
    }
  }
  return credencialDoAmbiente(env);
}

// ── Verificação de conexão ──────────────────────────────────────────────────

/**
 * O resultado de testar uma credencial contra a API do fornecedor.
 *
 * Três estados e não dois. "Falhou" junta coisas que pedem ações opostas: token errado
 * (troque o token) e fornecedor fora do ar (espere e tente de novo). Quem recebe
 * "falhou" sem a distinção vai trocar um token que estava certo.
 */
export type EstadoDaConexao =
  "ok" | "credencial_recusada" | "indisponivel" | "sem_credencial";

export interface Conexao {
  readonly chave: string;
  readonly estado: EstadoDaConexao;
  /** O que fazer a respeito. Aparece na tela. */
  readonly diagnostico: string;
  readonly httpStatus?: number;
  readonly duracaoMs: number;
}

/** O veredito, sem os campos que só quem chamou sabe (chave e duração). */
export type Diagnostico = Omit<Conexao, "chave" | "duracaoMs">;

const TEMPO_LIMITE_MS = 10_000;

/**
 * Uma requisição de leitura, com tempo limite.
 *
 * Sem limite, uma API que aceita a conexão e não responde deixa a tela girando e o
 * operador sem saber se o token está certo. Dez segundos é mais que qualquer resposta
 * legítima destas três APIs e menos que a paciência de quem clicou.
 */
async function sondar(
  url: string,
  init: RequestInit,
): Promise<{ status: number; corpo: string } | { erroDeRede: string }> {
  const sinal = AbortSignal.timeout(TEMPO_LIMITE_MS);
  try {
    const r = await fetch(url, { ...init, signal: sinal });
    // Só o começo do corpo: mensagem de erro de API costuma ser curta, e ler
    // megabytes de uma resposta inesperada não ajuda em nada.
    return { status: r.status, corpo: (await r.text()).slice(0, 400) };
  } catch (err) {
    return { erroDeRede: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * HubSpot: lista 1 deal. É a menor leitura que exercita o escopo que o C4/C5 precisa.
 *
 * Pedir 1 e não 100 porque o objetivo é validar credencial e escopo, não trazer dado —
 * e uma sonda que puxa volume acaba sendo usada como sincronização por engano.
 */
async function sondarHubspot(token: string): Promise<Diagnostico> {
  const r = await sondar(
    "https://api.hubapi.com/crm/v3/objects/deals?limit=1",
    {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    },
  );
  if ("erroDeRede" in r) {
    return {
      estado: "indisponivel",
      diagnostico:
        `não foi possível falar com a api.hubapi.com (${r.erroDeRede}). ` +
        "Pode ser rede da VM ou instabilidade do HubSpot — o token não foi testado.",
    };
  }
  return classificarHubspot(r.status);
}

/**
 * A classificação do HubSpot, separada da chamada.
 *
 * Separada por um motivo de teste, não de estética: com a classificação dentro da
 * função que faz `fetch`, o único teste possível seria bater na API do fornecedor — e
 * teste que falha quando o HubSpot tem um dia ruim é o primeiro a ser ignorado. Assim a
 * regra é exercida de verdade, e o defeito real (400 do CleverTap tratado como
 * indisponibilidade) tem portão.
 */
export function classificarHubspot(status: number): Diagnostico {
  if (status === 200) {
    return {
      estado: "ok",
      diagnostico: "token válido e com escopo de leitura de deals.",
      httpStatus: 200,
    };
  }
  if (status === 401) {
    return {
      estado: "credencial_recusada",
      diagnostico:
        "o HubSpot recusou o token (401). Ele expirou, foi revogado, ou foi colado incompleto.",
      httpStatus: 401,
    };
  }
  if (status === 403) {
    // 403 e não 401 é a distinção que economiza uma hora: o token é válido, falta
    // escopo. Trocar o token não resolve; editar a Private App resolve.
    return {
      estado: "credencial_recusada",
      diagnostico:
        "token aceito mas SEM escopo de leitura de deals (403). Não troque o token — " +
        "edite a Private App no HubSpot e marque crm.objects.deals.read.",
      httpStatus: 403,
    };
  }
  if (status === 429) {
    return {
      estado: "indisponivel",
      diagnostico:
        "o HubSpot está limitando a taxa (429). O token pode estar certo; tente em alguns minutos.",
      httpStatus: 429,
    };
  }
  return {
    estado: "indisponivel",
    diagnostico: `o HubSpot respondeu ${status}, que não é uma resposta esperada desta sonda.`,
    httpStatus: status,
  };
}

/** CleverTap: o par account-id + passcode vai em cabeçalho. */
async function sondarClevertap(
  accountId: string,
  passcode: string,
  regiao: string,
): Promise<Diagnostico> {
  // A região decide o host. `eu1` e outras têm prefixo próprio; sem ele o pedido vai
  // para a conta errada e volta 401 — que seria lido como "passcode errado".
  const host =
    regiao && regiao !== "us1"
      ? `${regiao}.api.clevertap.com`
      : "api.clevertap.com";
  const r = await sondar(`https://${host}/1/counts/profiles.json`, {
    method: "POST",
    headers: {
      "X-CleverTap-Account-Id": accountId,
      "X-CleverTap-Passcode": passcode,
      "content-type": "application/json",
    },
    body: JSON.stringify({ event_name: "App Launched" }),
  });
  if ("erroDeRede" in r) {
    return {
      estado: "indisponivel",
      diagnostico: `não foi possível falar com ${host} (${r.erroDeRede}). A credencial não foi testada.`,
    };
  }
  return classificarClevertap(r.status, regiao);
}

/**
 * A classificação do CleverTap.
 *
 * O 400 entra em `credencial_recusada` e NÃO em `indisponivel`. Foi o defeito real desta
 * sonda: o CleverTap devolve 400 para Account ID malformado, e classificar isso como
 * problema do fornecedor manda o operador ESPERAR quando a ação é conferir o valor
 * colado. É precisamente o erro que os três estados existem para evitar — e só apareceu
 * rodando contra a API de verdade.
 */
export function classificarClevertap(
  status: number,
  regiao: string,
): Diagnostico {
  if (status === 200) {
    return {
      estado: "ok",
      diagnostico: `credencial válida na região ${regiao || "us1"}.`,
      httpStatus: 200,
    };
  }
  if (status === 400 || status === 401 || status === 403) {
    return {
      estado: "credencial_recusada",
      diagnostico:
        `o CleverTap recusou (${status}). Confira o par Account ID + Passcode e, ` +
        `principalmente, a REGIÃO: com a região errada o pedido vai para outra conta e o ` +
        `erro é o mesmo de senha errada.`,
      httpStatus: status,
    };
  }
  return {
    estado: "indisponivel",
    diagnostico: `o CleverTap respondeu ${status}, fora do esperado por esta sonda.`,
    httpStatus: status,
  };
}

/** Omie: as chaves vão no CORPO, não em cabeçalho — é a API deles. */
async function sondarOmie(
  appKey: string,
  appSecret: string,
): Promise<Diagnostico> {
  const r = await sondar("https://app.omie.com.br/api/v1/geral/clientes/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      call: "ListarClientesResumido",
      app_key: appKey,
      app_secret: appSecret,
      param: [{ pagina: 1, registros_por_pagina: 1 }],
    }),
  });
  if ("erroDeRede" in r) {
    return {
      estado: "indisponivel",
      diagnostico: `não foi possível falar com app.omie.com.br (${r.erroDeRede}). As chaves não foram testadas.`,
    };
  }
  return classificarOmie(r.status, r.corpo);
}

/**
 * A classificação do Omie.
 *
 * Duas coisas que a documentação não conta e a execução real contou:
 *
 *   O Omie devolve 200 COM erro no corpo (`faultstring`) quando a credencial é
 *   inválida. Olhar só o status diria "ok" para uma chave errada.
 *
 *   E devolveu 403 na prática. A primeira versão desta função tinha "respondeu 200"
 *   cravado no texto, então a mensagem AFIRMAVA 200 enquanto o status era 403 —
 *   diagnóstico que mente sobre o que aconteceu é pior que diagnóstico ausente.
 */
export function classificarOmie(status: number, corpo: string): Diagnostico {
  if (status === 200 && !/faultstring|faultcode/i.test(corpo)) {
    return {
      estado: "ok",
      diagnostico: "App Key e App Secret válidos.",
      httpStatus: 200,
    };
  }
  if (/faultstring/i.test(corpo)) {
    // O `faultstring` vem com unicode escapado (`n\u00e3o`). Mostrar o escape cru
    // transformaria a mensagem do fornecedor — a informação mais útil aqui — em ruído.
    const bruto = /"faultstring"\s*:\s*"([^"]{0,200})"/i.exec(corpo)?.[1];
    const motivo = bruto?.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
    return {
      estado: "credencial_recusada",
      diagnostico:
        `o Omie recusou as chaves (HTTP ${status})${motivo ? `: "${motivo}"` : ""}. ` +
        "Atenção: esta API às vezes devolve 200 mesmo recusando, então a sonda olha o " +
        "corpo e não só o status.",
      httpStatus: status,
    };
  }
  return {
    estado: "indisponivel",
    diagnostico: `o Omie respondeu ${status}, fora do esperado por esta sonda.`,
    httpStatus: status,
  };
}

/**
 * Testa uma integração com as credenciais cadastradas.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Por que existe: sem isto, quem cola um token descobre que ele está errado   │
 * │ quando um ciclo falha de madrugada — e o alarme diz "C4 falhou", não "o     │
 * │ token está sem escopo". A distância entre colar e saber era de horas.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O `usado_em` é marcado: testar a credencial É usá-la, e a tela deixa de dizer
 * "nunca usado" no minuto em que alguém confere.
 */
/**
 * Lecupon (core): lê a PRIMEIRA PÁGINA de negócios. É a mesma rota que o C18 usa.
 *
 * Sondar a rota real e não um `/ping` é decisão: a credencial pode ser aceita pela API e
 * não ter permissão nesta rota, e uma sonda que valida outra coisa diria "ok" para uma
 * credencial que o ciclo vai recusar.
 */
async function sondarLecupon(
  token: string,
  email: string,
  tenantCnpj: string,
): Promise<Diagnostico> {
  const cab: Record<string, string> = {
    "X-ClientEmployee-Token": token,
    "X-ClientEmployee-Email": email,
    accept: "application/json",
  };
  // `Tenant-id` vazio e ausente dão o mesmo resultado (tenant padrão da credencial),
  // então o cabeçalho só vai quando tem valor.
  if (tenantCnpj) cab["Tenant-id"] = tenantCnpj;

  const r = await sondar(
    "https://api.lecupon.com/client/v3/businesses?page=1",
    {
      headers: cab,
    },
  );
  if ("erroDeRede" in r) {
    return {
      estado: "indisponivel",
      diagnostico:
        `não foi possível falar com a api.lecupon.com (${r.erroDeRede}). ` +
        "Pode ser rede da VM ou instabilidade do core — a credencial não foi testada.",
    };
  }
  return classificarLecupon(r.status, r.corpo);
}

/**
 * A classificação da Lecupon, separada da chamada para poder ser testada sem bater na
 * API do fornecedor.
 *
 * O 401 dela é a armadilha conhecida: a API devolve 401 "Acesso negado" tanto para token
 * errado quanto para o cabeçalho escrito errado (`X-Client-Employee-Token`, com o hífen a
 * mais). São ações diferentes, e o texto diz as duas.
 */
export function classificarLecupon(status: number, corpo: string): Diagnostico {
  if (status === 200) {
    // 200 com corpo que não parece lista é sinal de contrato mudado, não de credencial
    // boa — e o C18 leria zero SEM falhar, que é o pior desfecho.
    const pareceLista =
      /"(businesses|data|results)"\s*:/.test(corpo) ||
      corpo.trimStart().startsWith("[");
    if (!pareceLista) {
      return {
        estado: "indisponivel",
        diagnostico:
          "a credencial foi aceita (200) mas a resposta não parece a lista de negócios. " +
          "Provável mudança de contrato da API — o C18 leria zero sem falhar.",
        httpStatus: 200,
      };
    }
    return {
      estado: "ok",
      diagnostico:
        "credencial válida e com acesso à lista de negócios do core.",
      httpStatus: 200,
    };
  }
  if (status === 401 || status === 403) {
    return {
      estado: "credencial_recusada",
      diagnostico:
        `o core recusou a credencial (${status}). São três causas com ações diferentes: ` +
        "token expirado ou revogado; e-mail que não é o da conta que gerou o token; ou o " +
        "par estar certo e faltar permissão para esta rota.",
      httpStatus: status,
    };
  }
  if (status === 404) {
    return {
      estado: "indisponivel",
      diagnostico:
        "a rota de negócios respondeu 404. Não é credencial: é caminho ou versão da API " +
        "(o C18 usa /client/v3).",
      httpStatus: 404,
    };
  }
  if (status === 429) {
    return {
      estado: "indisponivel",
      diagnostico:
        "o core está limitando a taxa (429). A credencial pode estar certa; tente depois.",
      httpStatus: 429,
    };
  }
  return {
    estado: "indisponivel",
    diagnostico: `o core respondeu ${status}, que não é uma resposta esperada desta sonda.`,
    httpStatus: status,
  };
}

export async function testarConexao(
  db: pg.Pool,
  integracao: string,
): Promise<Conexao> {
  const inicio = process.hrtime.bigint();
  const fim = (r: Omit<Conexao, "chave" | "duracaoMs">): Conexao => ({
    chave: integracao,
    ...r,
    duracaoMs: Number((process.hrtime.bigint() - inicio) / 1_000_000n),
  });

  const semCredencial = (quais: string): Conexao =>
    fim({
      estado: "sem_credencial",
      diagnostico: `${quais} não cadastrado(s) — não há o que testar.`,
    });

  try {
    if (integracao === "hubspot") {
      if (!(await segredoExiste(db, "hubspot.token")))
        return semCredencial("token do HubSpot");
      return fim(await sondarHubspot(await usarSegredo(db, "hubspot.token")));
    }

    if (integracao === "clevertap") {
      const [temId, temPass] = await Promise.all([
        segredoExiste(db, "clevertap.account_id"),
        segredoExiste(db, "clevertap.passcode"),
      ]);
      if (!temId || !temPass) {
        return semCredencial(
          !temId && !temPass
            ? "Account ID e Passcode"
            : !temId
              ? "Account ID"
              : "Passcode",
        );
      }
      const regiao = (await segredoExiste(db, "clevertap.region"))
        ? await usarSegredo(db, "clevertap.region")
        : "us1";
      return fim(
        await sondarClevertap(
          await usarSegredo(db, "clevertap.account_id"),
          await usarSegredo(db, "clevertap.passcode"),
          regiao,
        ),
      );
    }

    if (integracao === "omie") {
      const [temKey, temSecret] = await Promise.all([
        segredoExiste(db, "omie.app_key"),
        segredoExiste(db, "omie.app_secret"),
      ]);
      if (!temKey || !temSecret) {
        return semCredencial(
          !temKey && !temSecret
            ? "App Key e App Secret"
            : !temKey
              ? "App Key"
              : "App Secret",
        );
      }
      return fim(
        await sondarOmie(
          await usarSegredo(db, "omie.app_key"),
          await usarSegredo(db, "omie.app_secret"),
        ),
      );
    }

    if (integracao === "lecupon") {
      const [temToken, temEmail] = await Promise.all([
        segredoExiste(db, "lecupon.employee_token"),
        segredoExiste(db, "lecupon.employee_email"),
      ]);
      if (!temToken || !temEmail) {
        return semCredencial(
          !temToken && !temEmail
            ? "token e e-mail de employee"
            : !temToken
              ? "token de employee"
              : "e-mail de employee",
        );
      }
      // O CNPJ do tenant é OPCIONAL: sem ele a API usa o tenant padrão da credencial.
      const tenant = (await segredoExiste(db, "lecupon.tenant_cnpj"))
        ? await usarSegredo(db, "lecupon.tenant_cnpj")
        : "";
      return fim(
        await sondarLecupon(
          await usarSegredo(db, "lecupon.employee_token"),
          await usarSegredo(db, "lecupon.employee_email"),
          tenant,
        ),
      );
    }

    return fim({
      estado: "indisponivel",
      diagnostico: `não existe sonda para "${integracao}".`,
    });
  } catch (err) {
    // Erro de cifra ou de banco. A mensagem de `SegredoCorrompidoError` não contém o
    // valor, então pode ir para a tela como está.
    return fim({
      estado: "indisponivel",
      diagnostico:
        err instanceof Error
          ? err.message
          : "falha inesperada ao ler a credencial",
    });
  }
}

/** As integrações que têm sonda, para a tela oferecer o botão só onde faz sentido. */
export const INTEGRACOES_SONDAVEIS = [
  "hubspot",
  "clevertap",
  "omie",
  "lecupon",
] as const;

/** Qual integração cada chave de segredo pertence. */
export const INTEGRACAO_DA_CHAVE: Readonly<Record<string, string>> = {
  "hubspot.token": "hubspot",
  "hubspot.webhook_secret": "hubspot",
  "clevertap.account_id": "clevertap",
  "clevertap.passcode": "clevertap",
  "clevertap.region": "clevertap",
  "omie.app_key": "omie",
  "omie.app_secret": "omie",
  "lecupon.employee_token": "lecupon",
  "lecupon.employee_email": "lecupon",
  "lecupon.tenant_cnpj": "lecupon",
};

// ── Rotação da chave mestra ─────────────────────────────────────────────────

export interface ProgressoDaRotacao {
  readonly total: number;
  /** Já cifrados com a chave ATUAL. */
  readonly naChaveNova: number;
  /** Ainda dependentes de `PULSE_CHAVE_MESTRA_ANTERIOR`. */
  readonly naChaveAntiga: number;
  /** Nem uma nem outra decifra — precisa ser recadastrado. */
  readonly ilegiveis: readonly string[];
}

/**
 * Quantos segredos ainda dependem da chave anterior.
 *
 * Existe para responder "posso apagar `PULSE_CHAVE_MESTRA_ANTERIOR`?" sem chutar.
 * Apagar cedo demais deixa segredo indecifrável e a integração cai na próxima
 * execução do ciclo — que é de madrugada, e o alarme diz "C4 falhou".
 */
export async function progressoDaRotacao(
  db: pg.Pool,
): Promise<ProgressoDaRotacao> {
  const { rows } = await db.query<{ chave: string; valor_cifrado: string }>(
    "SELECT chave, valor_cifrado FROM ops.segredo ORDER BY chave",
  );
  let naChaveNova = 0;
  let naChaveAntiga = 0;
  const ilegiveis: string[] = [];

  for (const r of rows) {
    if (cifradoComAChaveAtual(r.valor_cifrado)) {
      naChaveNova++;
      continue;
    }
    // Não decifra com a atual: ou é a anterior, ou é ilegível. `decifrar` já tenta as
    // duas, então basta ver se ele consegue.
    try {
      decifrar(r.valor_cifrado);
      naChaveAntiga++;
    } catch {
      ilegiveis.push(r.chave);
    }
  }
  return { total: rows.length, naChaveNova, naChaveAntiga, ilegiveis };
}

/**
 * Regrava todo segredo com a chave ATUAL.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Cada segredo em sua própria transação, de propósito. Numa transação só, um  │
 * │ valor ilegível no meio abortaria a regravação dos anteriores — e a rotação  │
 * │ ficaria pela metade sem ninguém saber quais tinham passado. Assim cada um   │
 * │ avança ou falha sozinho, e o relatório diz exatamente quais faltam.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `dica` e `usado_em` são preservados: a dica é derivada do valor claro, que não muda,
 * e zerar `usado_em` faria a tela dizer "nunca usado" para uma integração que roda há
 * meses — apagando justamente o sinal de que o segredo ainda serve.
 *
 * É idempotente: rodar de novo não muda nada além do texto cifrado (IV novo a cada
 * chamada, o que é correto e esperado).
 */
export async function rotacionarSegredos(
  db: pg.Pool,
  id: Identidade,
): Promise<{
  regravados: string[];
  falharam: { chave: string; motivo: string }[];
}> {
  const { rows } = await db.query<{ chave: string; valor_cifrado: string }>(
    "SELECT chave, valor_cifrado FROM ops.segredo ORDER BY chave",
  );
  const regravados: string[] = [];
  const falharam: { chave: string; motivo: string }[] = [];

  for (const r of rows) {
    try {
      // Decifra com o que funcionar (atual ou anterior) e regrava com a atual.
      const claro = decifrar(r.valor_cifrado);
      await db.query(
        `UPDATE ops.segredo SET valor_cifrado = $2, atualizado_por = $3, atualizado_em = now()
          WHERE chave = $1`,
        [r.chave, cifrar(claro), `${id.email} (rotação de chave)`],
      );
      regravados.push(r.chave);
    } catch (err) {
      falharam.push({
        chave: r.chave,
        // A mensagem de `SegredoCorrompidoError` não contém o valor — pode ir ao log.
        motivo: err instanceof Error ? err.message : "falha desconhecida",
      });
    }
  }

  if (regravados.length > 0) {
    await db.query(
      `INSERT INTO ops.mudanca (tipo, chave, quem, motivo)
       VALUES ('segredo', 'rotacao-da-chave-mestra', $1, $2)`,
      [
        id.email,
        `${regravados.length} segredo(s) regravado(s) com a chave nova` +
          (falharam.length > 0 ? `; ${falharam.length} falhou/falharam` : ""),
      ],
    );
  }
  return { regravados, falharam };
}
