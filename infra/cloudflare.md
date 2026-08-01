# Cloudflare + origem: o que ligar, e o que NÃO resolve o quê

`pulse.alloyal.com.br` está no Cloudflare com proxy ativo (nuvem laranja) e há
certificado de origem criado. Este arquivo é o que falta, na ordem, com o motivo de
cada passo — e uma correção de rumo sobre o modo de SSL.

## 1 · O modo é **Full (Strict)**, não Full

Os quatro certificados de origem já instalados no NPM foram verificados na VM e são
todos **Cloudflare Origin CA**:

| Certificado | Hostname | Emissor |
|---|---|---|
| npm-2 | `hub.a.alloyal.com.br` | CloudFlare Origin SSL Certificate Authority |
| npm-3 | `hub.alloyal.com.br` | CloudFlare Origin SSL Certificate Authority |
| npm-5 | `publi.alloyal.com.br` | CloudFlare Origin SSL Certificate Authority |
| npm-6 | `metas.alloyal.com.br` | CloudFlare Origin SSL Certificate Authority |

Isso é o que decide a escolha. **Origin CA existe exatamente para o modo Strict**: o
Cloudflare confia na própria CA dele, valida o certificado, e a conexão
Cloudflare↔origem passa a ser autenticada e não só cifrada.

**Full (sem Strict) cifra e NÃO valida.** Aceita certificado autoassinado, expirado ou
com hostname errado — ou seja, aceita o certificado de quem estiver no meio do caminho.
Para uma superfície que expõe receita da empresa e dado pessoal, a diferença entre os
dois modos é justamente a que importa: Full protege contra escuta passiva, Strict
protege contra alguém se passando pela origem.

## 2 · Não é page rule — é configuração do zone

O modo de SSL/TLS fica em **SSL/TLS → Overview**, e vale para o **zone inteiro**. Page
Rules são o mecanismo legado (o Cloudflare vem migrando para Rules) e, para um ajuste
que já é do zone, uma page rule não acrescenta nada além de um lugar a mais para
alguém procurar depois.

**A consequência de ser do zone:** mudar afeta os SETE hostnames de `alloyal.com.br`,
não só o pulse. Foi por isso que verifiquei os certificados antes de recomendar — se
algum dos seis existentes usasse autoassinado, Strict o derrubaria. Todos são Origin
CA, então a mudança é segura para o conjunto.

### ⚠ Um hostname quebra sob Strict — e é o `hub`

**Correção de um achado anterior.** Eu havia dito que `enable` servia o certificado do
`hub`. A leitura do banco do NPM mostra o contrário, e mais simples de resolver:

| Hostname | Certificado no banco | Sob Strict |
|---|---|---|
| **`hub`** | id 10 — **"hub.alloyal.com.br PLACEHOLDER (autoassinado)"** | **FALHA** |
| `enable` | id 9 — "enable.alloyal.com.br Origin" | ok |
| `publi`, `metas`, `evolution`, `supabase-metas`, `allvoice` | corretos | ok |

O que me enganou: existe `/data/custom_ssl/npm-3` no disco, resto do certificado id 3
(**apagado do banco**), e a config de nginx gerada antes disso ainda o referenciava. O
arquivo em disco não estava sincronizado com o banco.

Então só o `hub` quebra, e por um certificado **autoassinado** que alguém marcou
explicitamente como PLACEHOLDER no nome. O conserto é emitir um Origin Certificate para
`hub.alloyal.com.br` e trocar na aba SSL do proxy host dele.

**Como o page rule mudou a urgência:** você escopou o Full (Strict) em
`pulse.alloyal.com.br/*`, então o `hub` continua no modo do zone e de pé — verificado,
307. O conserto dele deixou de ser bloqueio e virou dívida com prazo: enquanto o Strict
não for do zone inteiro, ele funciona.

## 3 · O que Full (Strict) NÃO resolve, e é a lacuna maior

Verificado na VM:

```
443/tcp   ALLOW   Anywhere    # HTTPS NPM
```

A porta 443 aceita conexão de **qualquer origem**. Full (Strict) protege o trecho
Cloudflare↔origem, mas não impede alguém de **ignorar o Cloudflare**: quem descobrir o
IP da VM fala direto com o NPM, com `Host: pulse.alloyal.com.br`, e passa por fora de
WAF, rate limit e proteção de bot.

O SSO ainda barra (o oauth2-proxy continua exigindo Google), então não é acesso
concedido — é a camada de proteção do Cloudflare virando decorativa, e a origem
exposta a sondagem à vontade.

### 3a · Authenticated Origin Pulls (mTLS) — a solução forte

O Cloudflare apresenta um certificado de CLIENTE e o nginx exige que ele seja válido.
Requisição que não vem do Cloudflare é recusada no handshake, antes de qualquer coisa.

Sobrevive a mudança de faixa de IP, que é a fraqueza da opção 3b.

No NPM, no Advanced Config do host (ou no `nginx.conf` do container):

```nginx
ssl_client_certificate /data/custom_ssl/cloudflare-origin-pull-ca.pem;
ssl_verify_client on;
```

O PEM é o certificado público da CA de origin pull do Cloudflare, disponível na
documentação deles. E ligar **Authenticated Origin Pulls** em SSL/TLS → Origin Server.

### 3b · Firewall só para as faixas do Cloudflare — a solução simples

```bash
sudo ufw delete allow 80/tcp
sudo ufw delete allow 443/tcp
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow from "$ip" to any port 80,443 proto tcp comment 'Cloudflare'
done
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from "$ip" to any port 80,443 proto tcp comment 'Cloudflare v6'
done
```

**A pegadinha:** as faixas mudam. Sem um job que reaplique, um dia o Cloudflare passa a
sair de uma faixa nova e o site cai — e o sintoma (502 intermitente para parte dos
visitantes) não parece firewall. Se for por aqui, o job de atualização não é opcional.

**Faça as duas.** O mTLS é a barreira que não envelhece; o firewall reduz a superfície
antes do handshake.

## 4 · Antes de expor: HSTS já vai ligado pela aplicação

`packages/ui/cabecalhos.mjs` envia
`Strict-Transport-Security: max-age=31536000; includeSubDomains`.

Um ano é compromisso real: enquanto durar, nenhum navegador que já visitou aceita HTTP
neste host. Isso é o que se quer — mas ligue **Always Use HTTPS** no Cloudflare antes,
para que nada dependa de o visitante acertar o esquema.

`includeSubDomains` aqui alcança `*.pulse.alloyal.com.br`, e não `alloyal.com.br` — não
há risco de arrastar os outros produtos.

## 5 · Ordem de execução

1. Instalar o certificado de `pulse.alloyal.com.br` no NPM:
   `bash infra/instalar-certificado.sh pulse.alloyal.com.br <cert.pem> <chave.key>`
   O script confere o PAR e o HOSTNAME antes de enviar — as duas causas de 526.
2. Criar o proxy host de `pulse.alloyal.com.br` apontando para `web-internal:3000`,
   com o Advanced Config de `infra/proxy-pulse.advanced.conf`.
3. Subir o `oauth2-proxy-pulse` (o config espera esse nome de contêiner) com o client
   OAuth do `C-07` e a redirect URI `https://pulse.alloyal.com.br/oauth2/callback`.
4. Substituir `SUBSTITUIR_PELO_MESMO_VALOR_DE_PULSE_PROXY_SECRET` pelo valor real, o
   mesmo do `.env` da aplicação.
5. **Só então** virar o zone para Full (Strict).
6. Authenticated Origin Pulls + firewall por faixa.

O passo 5 fica depois do 1 porque Strict com o certificado ausente derruba o host na
hora. E o 6 depois do 5 porque, se algo falhar, é bom ter uma variável só em jogo.

## 6 · Como conferir que ficou certo

```bash
# O certificado que o navegador vê é o do Cloudflare, não o de origem
echo | openssl s_client -connect pulse.alloyal.com.br:443 -servername pulse.alloyal.com.br 2>/dev/null \
  | openssl x509 -noout -issuer

# Cabeçalho de segurança: um valor por nome, nunca dois
curl -sI https://pulse.alloyal.com.br | grep -icE '^strict-transport-security'   # tem que ser 1
curl -sI https://pulse.alloyal.com.br | grep -icE '^x-frame-options'             # tem que ser 1

# A origem recusa quem não é Cloudflare (depois do passo 6)
curl -sI --resolve pulse.alloyal.com.br:443:144.33.13.117 https://pulse.alloyal.com.br
# esperado: falha de TLS, não uma resposta HTTP
```

O primeiro `grep -c` valendo **2** é o sintoma de proxy e aplicação definindo o mesmo
cabeçalho — foi o que este repositório tinha, com valores diferentes, e por isso o
`proxy-pulse.advanced.conf` deixou de definir cabeçalho de segurança.
