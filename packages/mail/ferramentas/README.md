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

**As duas linhas precisam estar ENTRE ASPAS no `.env`.** Sem aspas, a chave PEM tem
espaços e quebra qualquer `source` do arquivo — inclusive o dos scripts deste repo. Com
aspas, o Docker Compose ainda converte os `\n` escapados em quebras reais, que é o que o
`createSign` precisa.
