# Ferramentas do canal de e-mail

## `enviar-teste.mjs` — provar o envio ANTES de ligar o step-up

```bash
cd packages/mail && pnpm build
set -a; . ../../infra/.env; set +a
node ferramentas/enviar-teste.mjs alguem@alloyal.com.br
```

**A ordem importa, e é o ponto desta ferramenta.** `stepUpAtivo` só pergunta se o envio
está CONFIGURADO — não se ele funciona. Uma credencial presente e quebrada liga o
step-up, manda todo mundo para `/verificar` e nenhum código chega: ninguém entra, nem
quem administra. Testar o envio antes de virar `PULSE_VERIFICACAO_EMAIL=true` é o que
impede isso.

A saída de emergência é `PULSE_VERIFICACAO_EMAIL=false` em `infra/.env` e subir o
`web-internal` de novo — sem depender de e-mail nenhum.

## De onde vem a credencial

Conta de serviço do Google com delegação em todo o domínio, a MESMA do Allvoice
(`alloyal-alertas@evolution-auth.iam.gserviceaccount.com`), impersonando
`noreply@alloyal.com.br`. Chega por `GMAIL_SA_CLIENT_EMAIL` + `GMAIL_SA_PRIVATE_KEY` no
`infra/.env` — `contaDeServicoDoAmbiente` aceita esse par além do `GOOGLE_SA_JSON`.

A chave vai em **base64**, na variável `GMAIL_SA_PRIVATE_KEY_B64`, e isso é decisão:

- a PEM crua tem espaços e barras invertidas, e escrita no `.env` quebra qualquer
  `source` do arquivo com `PRIVATE: command not found` — é assim que os scripts deste
  repo carregam a configuração;
- aspas resolvem no shell e **não sobrevivem**: `sops -d --output-type dotenv` escreve
  sem aspas, então todo `make secrets-decrypt` desfaria a correção em silêncio;
- base64 não tem espaço, aspa nem barra. É seguro no shell, no Compose e no dotenv
  gerado, sem depender de ninguém lembrar de aspar.

`contaDeServicoDoAmbiente` aceita as três formas — `..._B64` primeiro, depois
`GOOGLE_SA_JSON`, depois a PEM crua — e devolve `null` se o base64 estiver quebrado, o
que mantém o step-up DESLIGADO em vez de trancar todo mundo sem código.

## Onde a credencial mora

No SOPS: `infra/secrets/pulse.env.sops.yaml`, cifrado com age e versionado no git. O
`infra/.env` é GERADO dele por `make secrets-decrypt` e nunca editado à mão — editar à
mão cria uma configuração que só existe nesta máquina e some no próximo comando.
