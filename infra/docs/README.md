# docs.alloyal.com.br — documentação de produto

Site estático servido atrás do Google SSO, no mesmo padrão de `evolution` e `radar`:
**nginx serve · oauth2-proxy autentica · Nginx Proxy Manager faz o ingresso com TLS.**

O conteúdo é o diretório `docs/` do próprio repositório, por bind mount somente-leitura.
Consequência prática: **atualizar um documento é `git pull`** — sem rebuild, sem restart.

## Por que atrás de SSO

Os documentos contêm valores de MRR, arquitetura de isolamento entre clientes, a lacuna
de backup remoto e o desenho de sigilo contratual. Nenhuma superfície humana desta VM
está aberta à internet — só APIs protegidas por chave. Este site segue a mesma regra.

## Deploy

### 1 · DNS *(ação sua, fora da VM)*

```
docs.alloyal.com.br    A    144.33.13.117
```

Aguarde propagar antes do passo 5 — o Let's Encrypt valida por HTTP e falha se o nome
ainda não resolver.

### 2 · Cliente OAuth do Google

No projeto GCP que já serve os outros apps, adicione a URI de redirect:

```
https://docs.alloyal.com.br/oauth2/callback
```

O `client_id` e o `client_secret` podem ser os mesmos dos outros apps — o que precisa
ser único por domínio é a URI de redirect.

### 3 · Segredos

```bash
cp infra/docs/oauth2.env.example infra/docs/oauth2.env
chmod 600 infra/docs/oauth2.env
openssl rand -hex 16          # 32 caracteres → OAUTH2_PROXY_COOKIE_SECRET
```

> ⚠️ O cookie secret precisa ter **16, 24 ou 32 bytes**. `openssl rand -hex 16` dá 32
> caracteres e funciona. `openssl rand -base64 32` dá 44 e causa erro de AES —
> armadilha já documentada em `/opt/stack/CLAUDE.md`.

> ⚠️ Se existir um `oauth2.env` com valores `placeholder-local`, ele é de validação
> local. **Substitua antes de subir o oauth2-proxy**, senão ninguém entra.

### 4 · Subir

```bash
cd /opt/alloyal-ops
docker compose -f infra/docs/docker-compose.yml up -d
docker compose -f infra/docs/docker-compose.yml ps
```

Nenhuma porta é publicada. Os dois contêineres ficam só na rede `proxy-net`, e o site
é inalcançável até o passo 5.

### 5 · Proxy host no Nginx Proxy Manager

Painel em `127.0.0.1:81` (túnel SSH), ou pela API — a config do NPM vive no volume
`proxy_npm_data`, não em arquivo, então este repositório guarda a **fonte de verdade
versionada** em `docs.advanced.conf`.

| Campo | Valor |
|---|---|
| Domain Names | `docs.alloyal.com.br` |
| Scheme · Forward Host · Port | `http` · `ops-docs` · `80` |
| Block Common Exploits | ligado |
| Websockets Support | desligado (site estático) |
| SSL | Let's Encrypt · **Force SSL** · HTTP/2 |
| Access List | nenhuma — a proteção é o oauth2-proxy |
| **Advanced** | conteúdo de `docs.advanced.conf`, colado inteiro |

### 6 · Verificar

```bash
# em aba anônima: deve redirecionar para o Google, não abrir o documento
curl -sI https://docs.alloyal.com.br/ | head -3        # espera 302 para /oauth2/start

# depois de logar com e-mail @alloyal.com.br: índice com os dois PRDs
```

Checklist do que precisa estar verdadeiro:

- [ ] Aba anônima **não** abre o documento — redireciona para o Google
- [ ] E-mail fora de `@alloyal.com.br` é recusado
- [ ] `https://docs.alloyal.com.br/` mostra o índice
- [ ] Os dois PRDs abrem e a navegação lateral funciona
- [ ] Cabeçalho `X-Robots-Tag: noindex, nofollow` presente
- [ ] `https://docs.alloyal.com.br/algo-que-nao-existe` devolve 404, não listagem

## Atualizar um documento

```bash
cd /opt/alloyal-ops
git pull
```

Pronto. O bind mount é somente-leitura e o HTML não é cacheado (`no-cache,
must-revalidate`), então a versão nova aparece no próximo carregamento.

## Reverter

```bash
docker compose -f infra/docs/docker-compose.yml down
```

E remover o proxy host no NPM. Não há volume nem estado: derrubar não perde nada.

## Arquivos

| Arquivo | O que é |
|---|---|
| `docker-compose.yml` | nginx estático + oauth2-proxy do domínio |
| `nginx.conf` | servidor estático: sem listagem, sem cache de HTML, `noindex` |
| `docs.advanced.conf` | config do proxy host no NPM — **fonte de verdade versionada** |
| `oauth2.env.example` | modelo dos segredos; o arquivo real nunca é versionado |
