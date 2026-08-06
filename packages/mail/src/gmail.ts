/**
 * Cliente Gmail por REST, sem SDK — o mesmo mecanismo do Allvoice
 * (`alloyal-chat/api/src/email/gmail.client.ts`).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE SERVICE ACCOUNT E NÃO SMTP:                                        │
 * │                                                                            │
 * │ A casa tem os dois padrões em uso, e eles não são equivalentes:            │
 * │                                                                            │
 * │   · SMTP com senha  — `supabase-edge-functions` usa smtp.gmail.com com a    │
 * │     SENHA de uma conta humana (stack@). A senha dá acesso à CAIXA INTEIRA   │
 * │     daquela pessoa, não só ao envio, e some quando ela troca a senha.       │
 * │   · Service account + delegação — o Allvoice. A credencial é de máquina,    │
 * │     o escopo é só `gmail.send`, e a delegação autoriza impersonar UM        │
 * │     endereço. Ninguém precisa emprestar senha própria.                     │
 * │                                                                            │
 * │ O Pulse manda código de acesso: quem controla o envio controla a entrada.   │
 * │ Vai no padrão do Allvoice.                                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import { createSign } from "node:crypto";

const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

/** Só o envio. O Allvoice também pede `gmail.modify` porque LÊ caixa; o Pulse não lê. */
export const ESCOPO_ENVIO = "https://www.googleapis.com/auth/gmail.send";

export interface ContaDeServico {
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * Lê a conta de serviço do ambiente, aceitando as DUAS formas em uso na casa.
 *
 * O Pulse guarda `GOOGLE_SA_JSON` (JSON inteiro, um segredo só no SOPS); o
 * Allvoice guarda `GMAIL_SA_CLIENT_EMAIL` + `GMAIL_SA_PRIVATE_KEY` separados.
 * Aceitar as duas evita que a escolha do formato vire motivo de não enviar.
 */
export function contaDeServicoDoAmbiente(
  env: NodeJS.ProcessEnv,
): ContaDeServico | null {
  const json = (env["GOOGLE_SA_JSON"] ?? "").trim();
  if (json) {
    try {
      const o = JSON.parse(json) as Partial<ContaDeServico>;
      if (o.client_email && o.private_key) {
        return {
          client_email: o.client_email,
          private_key: normalizarChave(o.private_key),
        };
      }
    } catch {
      // JSON quebrado é erro de operação, e quem chama trata como "não configurado":
      // um throw aqui derrubaria a aplicação inteira na partida por causa do e-mail.
      return null;
    }
    return null;
  }
  const email = (env["GMAIL_SA_CLIENT_EMAIL"] ?? "").trim();

  // ┌───────────────────────────────────────────────────────────────────────────┐
  // │ `..._B64` VEM PRIMEIRO, e existe por um problema de ARQUIVO, não de cifra.  │
  // │                                                                            │
  // │ A chave PEM tem espaços e barras invertidas. Escrita crua no `.env`, ela     │
  // │ quebra qualquer `source` do arquivo com "PRIVATE: command not found" — e é   │
  // │ assim que os scripts deste repo carregam a configuração. Entre aspas o shell │
  // │ volta a funcionar, mas o `sops -d --output-type dotenv` escreve SEM aspas, e │
  // │ todo `make secrets-decrypt` desfaria a correção em silêncio.                │
  // │                                                                            │
  // │ Base64 não tem espaço, aspa nem barra: é seguro no shell, no Compose e no    │
  // │ dotenv gerado, sem depender de ninguém lembrar de aspar.                    │
  // └───────────────────────────────────────────────────────────────────────────┘
  const b64 = (env["GMAIL_SA_PRIVATE_KEY_B64"] ?? "").trim();
  if (email && b64) {
    try {
      const pem = Buffer.from(b64, "base64").toString("utf8");
      if (pem.includes("PRIVATE KEY")) {
        return { client_email: email, private_key: normalizarChave(pem) };
      }
    } catch {
      // Base64 quebrado é erro de operação: quem chama trata como "não configurado",
      // e o step-up fica DESLIGADO em vez de trancar todo mundo sem código.
      return null;
    }
    return null;
  }

  const chave = env["GMAIL_SA_PRIVATE_KEY"] ?? "";
  if (email && chave.trim())
    return { client_email: email, private_key: normalizarChave(chave) };
  return null;
}

/**
 * A chave PEM guardada em variável de ambiente vem com `\n` de DOIS caracteres.
 * Sem esta troca o `createSign` falha com erro de formato que não diz isso — é a
 * mesma armadilha que o Allvoice trata com `.replace(/\\n/g, '\n')`.
 */
function normalizarChave(bruta: string): string {
  return bruta.includes("\\n") ? bruta.replace(/\\n/g, "\n") : bruta;
}

export class ClienteGmail {
  constructor(private readonly accessToken: string) {}

  /**
   * Assina um JWT RS256 e troca por token, impersonando `assunto`.
   *
   * Exige delegação de domínio configurada no Workspace para o client id desta
   * conta de serviço, com o escopo abaixo. Sem isso o Google devolve
   * `unauthorized_client`, que NÃO quer dizer credencial errada — quer dizer
   * credencial certa sem permissão de impersonar. É o erro mais confundido deste
   * fluxo, por isso a mensagem abaixo o traduz.
   */
  static async porContaDeServico(
    sa: ContaDeServico,
    assunto: string,
    escopos: readonly string[] = [ESCOPO_ENVIO],
  ): Promise<ClienteGmail> {
    const agora = Math.floor(Date.now() / 1000);
    const enc = (o: unknown): string =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const semAssinatura =
      enc({ alg: "RS256", typ: "JWT" }) +
      "." +
      enc({
        iss: sa.client_email,
        sub: assunto,
        scope: escopos.join(" "),
        aud: OAUTH_TOKEN,
        iat: agora,
        exp: agora + 3600,
      });
    const assinatura = createSign("RSA-SHA256")
      .update(semAssinatura)
      .sign(sa.private_key)
      .toString("base64url");

    const resp = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${semAssinatura}.${assinatura}`,
      }),
    });
    if (!resp.ok) {
      const corpo = await resp.text();
      throw new Error(
        `${resp.status}: ${traduzirErroDeToken(corpo, assunto, sa.client_email)}`,
      );
    }
    const j = (await resp.json()) as { access_token: string };
    return new ClienteGmail(j.access_token);
  }

  async enviarBruto(rawBase64url: string): Promise<{ id: string }> {
    const resp = await fetch(`${GMAIL}/users/me/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: rawBase64url }),
    });
    if (!resp.ok)
      throw new Error(`gmail send ${resp.status}: ${await resp.text()}`);
    return (await resp.json()) as { id: string };
  }
}

/**
 * Traduz os dois erros que este fluxo dá, e que dizem a coisa errada.
 *
 * Função pura e exportada porque é a parte que se consegue testar sem falar com
 * o Google — e porque diagnóstico errado aqui custa horas: as duas mensagens do
 * Google apontam para a credencial, e nos dois casos a credencial está certa.
 */
export function traduzirErroDeToken(
  corpo: string,
  assunto: string,
  saEmail: string,
): string {
  if (corpo.includes("unauthorized_client")) {
    return (
      `o Google recusou impersonar ${assunto}. A credencial está certa; falta a DELEGAÇÃO ` +
      `DE DOMÍNIO no Workspace (Segurança → Controles de API → Delegação): autorize o client id ` +
      `de ${saEmail} para o escopo ${ESCOPO_ENVIO}. — resposta: ${corpo}`
    );
  }
  if (corpo.includes("invalid_grant")) {
    return (
      `o Google recusou o JWT. As causas em ordem de frequência: (1) ${assunto} não existe no ` +
      `Workspace, (2) relógio da máquina fora de hora, (3) a chave privada foi colada com \\n ` +
      `literal. — resposta: ${corpo}`
    );
  }
  return corpo;
}
