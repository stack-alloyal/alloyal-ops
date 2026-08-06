import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contaDeServicoDoAmbiente,
  traduzirErroDeToken,
  ESCOPO_ENVIO,
} from "./gmail.js";
import {
  codificar2047,
  configuracaoDoAmbiente,
  montarMime,
  remetenteFormatado,
  type ConfiguracaoDeEnvio,
} from "./mailer.js";
import { escaparHtml, hrefSeguro, montarEmail } from "./template.js";

const CHAVE_FALSA =
  "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";

const cfg: ConfiguracaoDeEnvio = {
  conta: {
    client_email: "sa@projeto.iam.gserviceaccount.com",
    private_key: CHAVE_FALSA,
  },
  remetente: "noreply@alloyal.com.br",
  nome: "Alloyal Pulse",
  responderPara: undefined,
};

// ─── Remetente ───────────────────────────────────────────────────────────────

test("o remetente padrão é Alloyal Pulse <noreply@alloyal.com.br>", () => {
  // Mesmo endereço do Allvoice, nome do produto — como lá o nome é "Allvoice".
  const c = configuracaoDoAmbiente({
    GOOGLE_SA_JSON: JSON.stringify(cfg.conta),
  });
  assert.ok(c);
  assert.equal(remetenteFormatado(c), "Alloyal Pulse <noreply@alloyal.com.br>");
});

test("o ambiente pode trocar nome e endereço do remetente", () => {
  const c = configuracaoDoAmbiente({
    GOOGLE_SA_JSON: JSON.stringify(cfg.conta),
    GMAIL_SENDER: "alerta@alloyal.com.br",
    GMAIL_FROM_NAME: "Pulse Alertas",
  });
  assert.equal(remetenteFormatado(c!), "Pulse Alertas <alerta@alloyal.com.br>");
});

// ─── Conta de serviço ────────────────────────────────────────────────────────

test("aceita as duas formas da casa: JSON inteiro e par separado", () => {
  const porJson = contaDeServicoDoAmbiente({
    GOOGLE_SA_JSON: JSON.stringify(cfg.conta),
  });
  const porPar = contaDeServicoDoAmbiente({
    GMAIL_SA_CLIENT_EMAIL: cfg.conta.client_email,
    GMAIL_SA_PRIVATE_KEY: CHAVE_FALSA,
  });
  assert.equal(porJson?.client_email, cfg.conta.client_email);
  assert.equal(porPar?.client_email, cfg.conta.client_email);
});

test("a chave com \\n de dois caracteres é normalizada", () => {
  // Chave PEM em variável de ambiente vem escapada. Sem esta troca o createSign
  // falha com erro de formato que não menciona `\n` — é a armadilha que o
  // Allvoice trata com o mesmo replace.
  const c = contaDeServicoDoAmbiente({
    GMAIL_SA_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
    GMAIL_SA_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----",
  });
  assert.ok(c!.private_key.includes("\n"));
  assert.ok(!c!.private_key.includes("\\n"));
});

test("sem credencial nenhuma devolve null — e não lança", () => {
  // Lançar aqui derrubaria a aplicação na partida por causa do e-mail. É o que
  // sustenta a trava anti-lockout do step-up.
  assert.equal(contaDeServicoDoAmbiente({}), null);
  assert.equal(configuracaoDoAmbiente({}), null);
});

test("JSON quebrado devolve null em vez de derrubar", () => {
  assert.equal(
    contaDeServicoDoAmbiente({ GOOGLE_SA_JSON: "{isso nao e json" }),
    null,
  );
});

test("JSON válido sem as chaves certas devolve null", () => {
  assert.equal(
    contaDeServicoDoAmbiente({ GOOGLE_SA_JSON: '{"type":"service_account"}' }),
    null,
  );
});

// ─── MIME ────────────────────────────────────────────────────────────────────

const decodificar = (raw: string) =>
  Buffer.from(raw, "base64url").toString("utf8");

test("o MIME traz From, To e Subject", () => {
  const m = decodificar(
    montarMime(
      { para: "a@alloyal.com.br", assunto: "Oi", html: "<p>x</p>" },
      cfg,
    ),
  );
  assert.match(m, /^From: Alloyal Pulse <noreply@alloyal\.com\.br>/m);
  assert.match(m, /^To: a@alloyal\.com\.br/m);
  assert.match(m, /^Subject: Oi/m);
});

test("assunto com acento é codificado em RFC 2047", () => {
  // Sem isto o assunto chega como "cÃ³digo" em parte dos clientes.
  const m = decodificar(
    montarMime(
      { para: "a@alloyal.com.br", assunto: "Seu código", html: "<p>x</p>" },
      cfg,
    ),
  );
  assert.match(m, /^Subject: =\?UTF-8\?B\?/m);
  assert.doesNotMatch(m, /^Subject: Seu código/m);
});

test("assunto ASCII fica legível, sem codificar à toa", () => {
  assert.equal(codificar2047("Codigo de acesso"), "Codigo de acesso");
});

test("o corpo vai em base64 com linhas de no máximo 76 caracteres", () => {
  // RFC 2045. Linha longa é refluída por algum hop no meio e o UTF-8 corrompe.
  const html = "<p>" + "á".repeat(500) + "</p>";
  const corpo = decodificar(
    montarMime({ para: "a@alloyal.com.br", assunto: "x", html }, cfg),
  ).split("\r\n\r\n")[1]!;
  for (const linha of corpo.split("\r\n")) {
    assert.ok(linha.length <= 76, `linha de ${linha.length} caracteres`);
  }
});

test("o corpo sobrevive à ida e volta com acento", () => {
  const html = "<p>ação, código e coração</p>";
  const corpo = decodificar(
    montarMime({ para: "a@alloyal.com.br", assunto: "x", html }, cfg),
  ).split("\r\n\r\n")[1]!;
  assert.equal(
    Buffer.from(corpo.replace(/\r\n/g, ""), "base64").toString("utf8"),
    html,
  );
});

test("Reply-To só aparece quando existe", () => {
  const sem = decodificar(
    montarMime({ para: "a@alloyal.com.br", assunto: "x", html: "y" }, cfg),
  );
  assert.doesNotMatch(sem, /^Reply-To:/m);
  const com = decodificar(
    montarMime(
      { para: "a@alloyal.com.br", assunto: "x", html: "y" },
      { ...cfg, responderPara: "noreply@alloyal.com.br" },
    ),
  );
  assert.match(com, /^Reply-To: noreply@alloyal\.com\.br/m);
});

// ─── Erros do Google ─────────────────────────────────────────────────────────

test('unauthorized_client é traduzido para "falta delegação", não "credencial errada"', () => {
  // O erro aponta para a credencial, e a credencial está certa. Diagnosticar isso
  // errado custa horas.
  const t = traduzirErroDeToken(
    '{"error":"unauthorized_client"}',
    "noreply@alloyal.com.br",
    "sa@x.iam",
  );
  assert.match(t, /DELEGAÇÃO/);
  assert.match(
    t,
    new RegExp(ESCOPO_ENVIO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("invalid_grant lista as causas na ordem em que acontecem", () => {
  const t = traduzirErroDeToken(
    '{"error":"invalid_grant"}',
    "noreply@alloyal.com.br",
    "sa@x.iam",
  );
  assert.match(t, /não existe no Workspace/);
  assert.match(t, /relógio/);
});

test("erro desconhecido passa inteiro, sem inventar diagnóstico", () => {
  assert.equal(traduzirErroDeToken("explodiu", "a@b", "c@d"), "explodiu");
});

// ─── Template ────────────────────────────────────────────────────────────────

test("o e-mail leva a marca Alloyal Pulse", () => {
  const h = montarEmail({ corpoHtml: "<p>oi</p>" });
  assert.match(h, /Alloyal Pulse/);
  assert.match(h, /#6A18E5/);
});

test("saudação e rodapé são escapados; o corpo não", () => {
  const h = montarEmail({
    saudacao: "<script>alert(1)</script>",
    corpoHtml: "<p>confio neste</p>",
    rodape: "a & b",
  });
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /a &amp; b/);
  assert.match(h, /<p>confio neste<\/p>/);
});

test("href que não seja http, https ou mailto vira #", () => {
  assert.equal(hrefSeguro("javascript:alert(1)"), "#");
  assert.equal(hrefSeguro("data:text/html,x"), "#");
  assert.equal(
    hrefSeguro("https://pulse.alloyal.com.br/x"),
    "https://pulse.alloyal.com.br/x",
  );
  assert.equal(
    hrefSeguro("mailto:a@alloyal.com.br"),
    "mailto:a@alloyal.com.br",
  );
});

test("aspas na URL não quebram o atributo", () => {
  assert.equal(
    hrefSeguro('https://x/"onmouseover="alert(1)'),
    "https://x/&quot;onmouseover=&quot;alert(1)",
  );
});

test("escaparHtml cobre os cinco", () => {
  assert.equal(escaparHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("a chave em base64 é aceita, e é a forma que sobrevive ao dotenv", () => {
  // A PEM crua tem espaços e barras: escrita no `.env` ela quebra `source`, e entre
  // aspas o `sops -d --output-type dotenv` as remove no próximo `make secrets-decrypt`.
  // Base64 não tem nenhum dos dois, então não depende de ninguém lembrar de aspar.
  const pem =
    "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n";
  const conta = contaDeServicoDoAmbiente({
    GMAIL_SA_CLIENT_EMAIL: "sa@projeto.iam.gserviceaccount.com",
    GMAIL_SA_PRIVATE_KEY_B64: Buffer.from(pem, "utf8").toString("base64"),
  });
  assert.equal(conta?.client_email, "sa@projeto.iam.gserviceaccount.com");
  assert.ok(
    conta?.private_key.includes("\n"),
    "a PEM precisa ter quebras REAIS para o createSign",
  );
  assert.ok(conta?.private_key.startsWith("-----BEGIN PRIVATE KEY-----"));
});

test("base64 quebrado NÃO configura o envio — e é assim que o step-up fica desligado", () => {
  // Configurado-e-quebrado é o pior estado: liga o step-up e nenhum código chega.
  const conta = contaDeServicoDoAmbiente({
    GMAIL_SA_CLIENT_EMAIL: "sa@projeto.iam.gserviceaccount.com",
    GMAIL_SA_PRIVATE_KEY_B64: "isto-nao-e-uma-chave",
  });
  assert.equal(conta, null);
});

test("o base64 tem precedência sobre a PEM crua", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nDOB64\n-----END PRIVATE KEY-----\n";
  const conta = contaDeServicoDoAmbiente({
    GMAIL_SA_CLIENT_EMAIL: "sa@projeto.iam.gserviceaccount.com",
    GMAIL_SA_PRIVATE_KEY_B64: Buffer.from(pem, "utf8").toString("base64"),
    GMAIL_SA_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\\nDACRUA\\n-----END PRIVATE KEY-----",
  });
  assert.match(conta?.private_key ?? "", /DOB64/);
});
