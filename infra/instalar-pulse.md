# Colocar `pulse.alloyal.com.br` no ar

Convenção da casa: os arquivos vivem em `/etc/alloyal/origin-ca/` como
`<produto>.crt` (644) e `<produto>.key` (600, root) — igual a `radar`, `enable` e
`hub`.

## 1 · Colar o certificado e a chave

O `umask 077` cria o arquivo já em 600. Sem ele, o arquivo nasce 644 e fica legível por
qualquer usuário da VM durante a colagem — janela curta, mas com uma chave de 15 anos
dentro.

O `<<'PEM'` **com aspas** é obrigatório: sem elas o shell interpreta `$` e crase no
conteúdo, e o PEM chega corrompido de um jeito que só aparece no handshake.

```bash
sudo mkdir -p /etc/alloyal/origin-ca

sudo sh -c 'umask 077; cat > /etc/alloyal/origin-ca/pulse.key' <<'PEM'
-----BEGIN PRIVATE KEY-----
<cole a chave privada>
-----END PRIVATE KEY-----
PEM

sudo sh -c 'umask 022; cat > /etc/alloyal/origin-ca/pulse.crt' <<'PEM'
-----BEGIN CERTIFICATE-----
<cole o certificado>
-----END CERTIFICATE-----
PEM
```

`umask 022` no `.crt` de propósito: certificado é público, e 644 é o que os outros
produtos usam. Só a chave é 600.

## 2 · Conferir ANTES de instalar

```bash
sudo openssl pkey -in /etc/alloyal/origin-ca/pulse.key -noout && echo "chave ok"
sudo wc -c /etc/alloyal/origin-ca/pulse.key    # RSA 2048 do Origin CA: 1704 bytes
```

**Isto não é zelo excessivo — esta VM já perdeu tempo com as duas falhas possíveis, e
ambas foram de UM byte:**

| Arquivo | Bytes | Linhas | O que houve |
|---|---|---|---|
| `enable.key.bak-truncada` | 1703 | 28 | faltou um caractere |
| `radar.key.bak-espaco` | 1705 | 28 | sobrou um espaço |
| `enable.key` (boa) | 1704 | 28 | — |

As três têm **28 linhas**. Contar linha não pega; olhar não pega. Só pedir ao `openssl`
para interpretar pega.

## 3 · Instalar no NPM

```bash
sudo bash infra/instalar-certificado.sh pulse
```

Refaz as validações acima, confere se o par casa, se o certificado cobre o hostname — e
só então cria o registro no banco do NPM e sobe os arquivos.

**Não copie para `/data/custom_ssl` à mão.** O NPM indexa no banco dele e nomeia as
pastas por ID; arquivo sem a linha no banco é um certificado que ele não enxerga. Esta
instalação já tem o inverso — `custom_ssl/npm-3` no disco com o registro apagado — e foi
o que me fez diagnosticar errado qual host quebrava sob Full (Strict).

## 4 · Criar o proxy host

```bash
sudo bash infra/criar-proxy-host.sh
```

Pela tela também dá, mas o script existe por um motivo: o Advanced Config precisa do
valor real de `PULSE_PROXY_SECRET` no lugar do placeholder, e copiar 64 caracteres para
um textarea é onde isso erra. Um caractere a mais dá **401 em tudo**, com a aplicação
dizendo só "não comprovou ter passado pelo proxy".

⚠️ **O forward é `web-internal:3000`, e NÃO `oauth2-proxy-pulse:4180`.**

Os outros produtos da casa encaminham para o oauth2-proxy, que fala com o app. O Pulse
não pode: a aplicação exige `X-Pulse-Proxy-Secret` como prova de ter passado pelo proxy,
e **o oauth2-proxy não injeta cabeçalho estático arbitrário** — só o nginx injeta. Por
isso o `oauth2-proxy-pulse` roda com `--upstream=static://200`: ele só responde ao
`auth_request`, e quem encaminha ao app é o nginx.

Copiar o padrão dos vizinhos aqui daria 401 em tudo.

A rede já está resolvida: o compose liga `web-internal` às DUAS — `pulse-net` (banco e
fila) e `proxy-net` (onde o NPM está). Verificado: o NPM resolve `web-internal` e
responde 200 com o cabeçalho de prova, 401 sem ele.

**Uma armadilha que custou uma tarde e não é óbvia:** o servidor standalone do Next usa
`process.env.HOSTNAME` como endereço de bind, e o Docker define essa variável com o ID
do contêiner — que resolve para o IP da rede PRIMÁRIA. Num contêiner em duas redes, o
Next escuta em uma e recusa conexão na outra.

Foi exatamente o que aconteceu aqui: 200 pela `pulse-net`, "connection refused" para o
NPM pela `proxy-net`. O sintoma final seria **502 Bad Gateway** com o contêiner de pé,
log limpo e a porta respondendo quando testada da rede errada.

O `Dockerfile` agora define `HOSTNAME=0.0.0.0`. Se algum dia voltar o 502, confira
primeiro:

```bash
docker exec pulse-web-internal sh -c 'cat /proc/net/tcp' | head -3
# precisa aparecer 00000000:0BB8 (0.0.0.0:3000), não o IP de uma rede só
```

## 5 · O SSO

O passo 4 já entrega a tela — mas **sem oauth2-proxy o Advanced Config devolve 502**,
porque ele faz `auth_request` para `oauth2-proxy-pulse:4180`, que ainda não existe.

Falta `infra/oauth2.env` com o client OAuth do Google (`C-07`):

```
OAUTH2_PROXY_CLIENT_ID=...
OAUTH2_PROXY_CLIENT_SECRET=...
OAUTH2_PROXY_COOKIE_SECRET=<openssl rand -hex 16>
```

⚠️ O cookie secret precisa de 16, 24 ou 32 **bytes**. `openssl rand -hex 16` dá 32
caracteres e funciona; `openssl rand -base64 32` dá 44 e o oauth2-proxy morre com erro
de AES.

Redirect URI a cadastrar no Google: `https://pulse.alloyal.com.br/oauth2/callback`.

Depois: `cd infra && docker compose up -d oauth2-proxy-pulse`

## 6 · O primeiro acesso

Banco de produção novo tem `ops.user_role` vazia, e a tela que concede papel exige
`configurar`. Sem isto, quem sobe a plataforma autentica no Google e vê a tela de
permissão para sempre.

```bash
make primeiro-admin EMAIL=stack@alloyal.com.br
```

Recusa rodar em banco que já tem alguém — depois da primeira pessoa, o caminho é
Configurações → Acessos, com motivo escrito e trilha.

## 7 · Conferir

```bash
curl -sI https://pulse.alloyal.com.br | head -1
# 302 para o Google = SSO funcionando

curl -sI https://pulse.alloyal.com.br | grep -icE '^strict-transport-security'
# 1. Se der 2, proxy e aplicação estão ambos definindo o cabeçalho.

echo | openssl s_client -connect pulse.alloyal.com.br:443 \
  -servername pulse.alloyal.com.br 2>/dev/null | openssl x509 -noout -issuer
# emissor Cloudflare = o visitante vê o certificado deles, não o de origem
```

**525** significa handshake com a origem falhando — certificado ausente ou errado.
**526** é certificado presente mas recusado pelo Strict: quase sempre hostname que não
casa.
