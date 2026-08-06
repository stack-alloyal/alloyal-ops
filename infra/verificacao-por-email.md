# Verificação por e-mail (step-up pós-SSO)

Depois de entrar com o Google, a pessoa digita um código de 6 dígitos enviado ao
próprio e-mail. Ao acertar, ganha um cookie de dispositivo assinado e não repete
por 30 dias.

Mesmo desenho do **Allvoice** (`alloyal-chat/api/src/auth/email-verify.service.ts`),
com as mesmas medidas: código de 6 dígitos, 10 minutos de validade, 1 envio por
minuto, 5 tentativas.

## Por que existe

A autenticação da superfície interna se apoia em dois cabeçalhos que o nginx
injeta: `X-Pulse-Proxy-Secret` e `X-Auth-Request-Email`. Quem conseguir escrever os
dois **é** a pessoa, para todos os efeitos — e o segredo do proxy vive em texto no
Advanced Config do NPM e no `.env` da VM.

O código não depende desse segredo: ele chega à **caixa real** do e-mail. Quem
forjou o cabeçalho não recebe, e não conclui.

## Trava anti-lockout — leia antes de mexer

O step-up só vale quando **as três** condições valem:

| | |
|---|---|
| `PULSE_VERIFICACAO_EMAIL=true` | a chave geral |
| `PULSE_VERIFICACAO_SEGREDO` preenchido | entra no hash do código e assina o cookie |
| envio configurado | `GOOGLE_SA_JSON` (ou `GMAIL_SA_CLIENT_EMAIL` + `GMAIL_SA_PRIVATE_KEY`) |

Faltando qualquer uma, ele fica **inerte** — a plataforma volta ao SSO puro
sozinha. Exigir código sem conseguir *mandar* código tranca todo mundo do lado de
fora, **inclusive quem consertaria**. A decisão mora em `stepUpAtivo`, que é pura e
testada; ver `packages/auth/src/verificacao.ts`.

Emergência: `PULSE_VERIFICACAO_EMAIL=false` e `docker compose up -d web-internal`.

Provado nesta instalação, contra a stack de pé:

```
flag=true · sem credencial de envio  → HTTP 200   (inerte, ninguém trancado)
flag=true · credencial presente      → 307 /verificar
```

## O que falta para ligar

Só a credencial de envio. `GOOGLE_SA_JSON` está **vazio**.

O Allvoice usa a conta de serviço `alloyal-alertas@evolution-auth.iam.gserviceaccount.com`,
com delegação de domínio para `gmail.send`, impersonando `noreply@alloyal.com.br`.
Duas saídas:

1. **Reaproveitar a mesma conta.** Zero configuração no Google — a delegação já
   existe. Custo: os dois produtos passam a depender da mesma chave, e rotacionar
   um mexe no outro.
2. **Conta de serviço própria do Pulse.** É a convenção que a casa já seguiu para
   o client OAuth (isolamento do segredo, rotação independente). Exige criar a
   conta no projeto GCP `59783477182` e autorizar o client id em
   **Segurança → Controles de API → Delegação em todo o domínio** para o escopo
   `https://www.googleapis.com/auth/gmail.send`.

Em qualquer dos dois, o JSON inteiro entra no SOPS:

```bash
make secrets-edit     # cole em GOOGLE_SA_JSON, numa linha só
make secrets-decrypt
cd infra && docker compose up -d web-internal
```

Depois, ligue: `PULSE_VERIFICACAO_EMAIL=true` no mesmo arquivo.

### O erro que vai aparecer se a delegação faltar

`unauthorized_client`. Ele aponta para a credencial, e a credencial está **certa** —
o que falta é a autorização de impersonar. `traduzirErroDeToken` já devolve essa
frase em vez da do Google, porque diagnosticar isso errado custa horas.

## Remetente

`Alloyal Pulse <noreply@alloyal.com.br>` — mesmo endereço do Allvoice
(`GMAIL_SENDER=noreply@alloyal.com.br`), nome próprio do produto, como lá o nome é
`Allvoice`. Quem recebe sabe de qual ferramenta veio sem abrir.

Vem de `GMAIL_SENDER` e `GMAIL_FROM_NAME`, com o padrão já correto no código —
`packages/mail/src/mailer.ts`.

`GMAIL_FROM_NAME` é o único valor do `.env` com espaço, e está **entre aspas**: sem
elas, `set -a; . infra/.env` quebra com `Pulse: command not found`. O parser do
`env_file` do compose remove as aspas, então o contêiner enxerga o mesmo valor —
conferido.

## Decisões que não são óbvias

- **O código não vai no assunto.** O assunto é logado no envio; o corpo não. OTP no
  assunto aparece no log, na prévia da notificação e na tela de bloqueio do
  celular — três lugares onde se lê sem desbloquear nada.
- **O hash leva o segredo dentro.** Seis dígitos são 1.000.000 de hashes que um
  laptop percorre num piscar. Sem o segredo, quem lesse `ops.codigo_verificacao`
  saberia o código de todo mundo.
- **O incremento de tentativa é atômico e vem ANTES da comparação.**
  `UPDATE ... WHERE tentativas < 5` devolvendo 0 linha *é* o "travado". A versão
  ingênua (ler, comparar, gravar) tem corrida: requisições simultâneas leem o mesmo
  contador e a trava de 5 erros deixa de valer. É bug que o Allvoice já teve.
- **O intervalo de reenvio não gera código novo.** Se gerasse, clicar "reenviar"
  duas vezes invalidaria o código que já está a caminho.
- **A tela não tem JavaScript.** Os dois botões carregam a escolha no `name`/`value`
  do submit e a mensagem volta pela URL. Ver o mesmo motivo em
  `apps/web-internal/app/(interno)/entrar/page.tsx`.
