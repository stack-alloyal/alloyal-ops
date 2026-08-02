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

### Client PRÓPRIO, não reaproveitado

A casa tem cinco oauth2-proxy no mesmo projeto GCP (`59783477182`): `hub/allvoice`,
`publi` e `evolution` com client próprio, e `radar`+`enable` **compartilhando** um.

O Pulse leva client próprio, por quatro motivos em ordem de peso:

1. **Isolamento do segredo.** Vazando o do Pulse, só o Pulse cai. Compartilhando, um
   vazamento em qualquer produto que use aquele client compromete todos — e o Pulse
   guarda receita, dado pessoal e contrato.
2. **Rotação independente.** Hoje girar o segredo do `radar` obriga a girar o do
   `enable` junto, e a indisponibilidade é dos dois.
3. **A tela de consentimento mostra o nome do app.** Compartilhando, quem entra no
   Pulse vê o nome de outro produto — no exato instante em que deveria reconhecer o
   que está autorizando.
4. É a convenção dominante: 3 de 5.

### Criar

Console do Google → **APIs e Serviços → Credenciais → Criar credenciais → ID do
cliente OAuth → Aplicativo da Web**

- Nome: `Alloyal Pulse`
- URI de redirecionamento autorizado:
  `https://pulse.alloyal.com.br/oauth2/callback`

Depois:

```bash
bash infra/configurar-oauth.sh
```

Ele pede os dois valores (o segredo sem eco), confere que o Client ID tem o formato do
Google e que é do MESMO projeto dos outros produtos — client de outro projeto autentica
contra outra base de usuários, e o sintoma é "e-mail não autorizado" para gente que
existe.

E gera o cookie secret com o tamanho certo. ⚠️ Ele precisa de 16, 24 ou 32 **bytes**:
`openssl rand -hex 16` dá 32 caracteres e funciona; `openssl rand -base64 32` dá 44 e o
oauth2-proxy **morre na partida** com erro de AES que não menciona tamanho.

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
# 200 = a TELA DE ENTRADA. Se der 302 para accounts.google.com, o `error_page`
# ainda aponta para /oauth2/start em vez de /oauth2/sign_in — rode
# `sudo bash infra/criar-proxy-host.sh`.

curl -s https://pulse.alloyal.com.br | grep -c 'Entrar com Google'
# 1. O botão vem no HTML, sem JavaScript nenhum.

curl -sI https://pulse.alloyal.com.br | grep -icE '^strict-transport-security'
# 1. Se der 2, proxy e aplicação estão ambos definindo o cabeçalho.
# (Com o 302 antigo dava 0: a resposta de entrada era a única sem cabeçalho
#  de segurança, porque vinha do nginx e não passava pela aplicação.)

echo | openssl s_client -connect pulse.alloyal.com.br:443 \
  -servername pulse.alloyal.com.br 2>/dev/null | openssl x509 -noout -issuer
# emissor Cloudflare = o visitante vê o certificado deles, não o de origem
```

**525** significa handshake com a origem falhando — certificado ausente ou errado.
**526** é certificado presente mas recusado pelo Strict: quase sempre hostname que não
casa.

## A tela de entrada

`pulse.alloyal.com.br` sem sessão responde **200** com a tela de entrada do
produto — painel de marca escuro à esquerda, botão do Google à direita.

Quem serve é o **oauth2-proxy**, por `--custom-templates-dir=/templates`, lendo
`infra/oauth2-templates/sign_in.html`. É a mesma mecânica do Publi
(`/opt/stack/apps/alloyal-publi/infra/oauth2-templates/`).

Duas coisas que fizeram a tela não aparecer, e que não são óbvias:

1. **`--skip-provider-button=true`** manda direto ao Google. Removido.
2. **`/oauth2/start` SEMPRE redireciona.** Quem serve a página é
   `/oauth2/sign_in`. O `error_page 401` do Advanced Config apontava para
   `start`; agora aponta para `sign_in`. Com o botão pulado ligado, nem `sign_in`
   mostrava — as duas coisas precisavam mudar juntas.

A rota de retorno viaja no cabeçalho `X-Auth-Request-Redirect`, que a
`location /oauth2/` define com `$request_uri`. Conferido: pedir `/relatorios/42`
sem sessão gera `href="/oauth2/start?rd=%2frelatorios%2f42"`.

### O custo, e a amarra

O desenho passa a existir em dois lugares: o `sign_in.html` e o
`packages/ui/src/Login.tsx`. É exatamente assim que a tela do Publi e a do
Allvoice divergiram.

`packages/ui/design-system.test.mjs` compara os dois — cada cor do `:root` contra
`estilo.css`, e título, chamada e etiquetas contra os padrões do `Login.tsx`.
Mexer num sem mexer no outro quebra o CI.

Em troca: a tela aparece mesmo com a aplicação ou o Postgres fora do ar, porque o
oauth2-proxy responde antes deles.

`apps/web-internal/app/(interno)/entrar/page.tsx` continua existindo, para quem
alcança a aplicação sem passar pelo proxy. Ele é PÁGINA e não `unauthorized()`
porque `unauthorized()` é uma interrupção que o Next resolve num boundary de
suspense: medido nesta instalação, página normal = 17.209 bytes de HTML e 31
âncoras; a mesma tela por `unauthorized()` = **0 âncoras**, ou seja, quem chega
sem JS não vê porta nenhuma.

### Aplicar

```bash
cd infra && docker compose up -d oauth2-proxy-pulse   # o template (já feito)
sudo bash infra/criar-proxy-host.sh                   # o error_page → sign_in
```

O script **atualiza** o host se ele já existir (PUT), em vez de criar um segundo
para o mesmo domínio — o nginx atenderia pelo primeiro que casasse e a edição
pareceria não ter pegado.

### Como esta instalação foi aplicada (01/08/2026)

O `criar-proxy-host.sh` é o caminho canônico e pede a senha do NPM. Nesta vez a
mudança foi aplicada **direto**, e fica registrado porque o estado difere um
pouco do que o script produziria:

1. `advanced_config` do host id 8 atualizado NO LUGAR, com um script `node`
   rodando **dentro** do contêiner `npm` (ele tem `better-sqlite3`). Rodar
   dentro evita copiar o banco para fora e de volta, que abriria janela para
   perder escrita concorrente do NPM — e o banco dele serve os 7 hostnames.
2. O SEGREDO não passou por fora: o script o extraiu do próprio valor que já
   estava no banco (`X-Pulse-Proxy-Secret "..."`) e o reinjetou no arquivo novo,
   que só tinha o placeholder.
3. `/data/nginx/proxy_host/8.conf` recebeu a mesma troca de linha por `sed`,
   seguido de `nginx -t` e `nginx -s reload` (recarga graciosa, sem derrubar os
   outros seis sites).

**Diferença conhecida:** o banco tem a versão COM os comentários novos; o
`8.conf` tem os comentários antigos e só a linha trocada. Funcionalmente
idênticos — conferido linha a linha. Na próxima vez que alguém salvar este host
pelo NPM, o arquivo passa a ter os comentários também.

**Backups**, dentro do contêiner, para apagar quando não fizerem mais falta:

```bash
docker exec npm rm -f /data/database.sqlite.antes-pulse-signin \
                      /data/nginx/proxy_host/8.conf.antes-pulse-signin
```

Rodar `sudo bash infra/criar-proxy-host.sh` continua sendo o jeito certo daqui
para a frente — ele agora atualiza o host existente em vez de duplicá-lo.
