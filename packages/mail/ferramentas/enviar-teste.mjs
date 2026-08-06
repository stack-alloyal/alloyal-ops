/**
 * Prova o envio de verdade ANTES de a flag do step-up ser ligada.
 *
 * A ordem importa: credencial presente e QUEBRADA passa no `stepUpAtivo` (que só
 * pergunta se está configurada) e tranca todo mundo na tela de verificação sem código
 * nenhum chegando. Testar antes é o que impede isso.
 */
import {
  Mailer,
  configuracaoDoAmbiente,
  remetenteFormatado,
} from "../dist/index.js";

const cfg = configuracaoDoAmbiente(process.env);
if (!cfg) {
  console.log(
    "   configuração AUSENTE — step-up continuaria desligado (trava anti-lockout)",
  );
  process.exit(1);
}
console.log("   remetente: " + remetenteFormatado(cfg));
console.log("   conta de serviço: " + cfg.conta.client_email);
console.log(
  "   chave PEM: " +
    (cfg.conta.private_key.includes("\n")
      ? "com quebras reais"
      : "SEM quebra — createSign falharia"),
);

try {
  const r = await new Mailer(cfg).enviar({
    para: process.argv[2],
    assunto: "Pulse — teste do canal de e-mail",
    texto:
      "Teste do canal de e-mail do Alloyal Pulse. Se você recebeu, o envio funciona.",
    html: "<p>Teste do canal de e-mail do <b>Alloyal Pulse</b>. Se você recebeu, o envio funciona.</p>",
  });
  console.log("   ENVIADO para " + process.argv[2] + " · id " + r.id);
} catch (e) {
  console.log("   FALHOU: " + String(e.message).slice(0, 500));
  process.exit(1);
}
