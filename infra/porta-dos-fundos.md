# A porta dos fundos da VM, e o impacto de fechá-la

Medido em 02/08/2026, contra a VM em produção.

## O problema

```bash
curl -k --resolve pulse.alloyal.com.br:443:144.33.13.117 https://pulse.alloyal.com.br
→ HTTP 200
```

Quem descobre o IP fala direto com o NPM. WAF, rate limit e proteção de DDoS do
Cloudflare ficam **fora do caminho** — não são consultados.

Não é falha de autenticação: pelo caminho direto, forjar cabeçalho de admin
continua dando 401, o SSO e o segredo do proxy seguram. É uma **camada de defesa
contornável**, e num produto com dado de cliente e acesso a banco isso não pode
ficar aberto.

## A validação que mudou a recomendação

A saída óbvia — `ufw` só aceitando 443 das faixas do Cloudflare — **quebraria três
serviços desta VM**.

### Quem passa pelo Cloudflare, e quem não passa

| hostname | resolve para | certificado |
|---|---|---|
| pulse, hub, publi, radar, enable, allvoice | 104.21.5.166 / 172.67.133.163 | Cloudflare (Google Trust Services) |
| **metas** | **144.33.13.117 (a VM)** | **Let's Encrypt** |
| **evolution** | **144.33.13.117 (a VM)** | **Let's Encrypt** |
| **supabase-metas** | **144.33.13.117 (a VM)** | **Let's Encrypt** |

Os três de baixo estão em DNS "cinza": não há Cloudflare no caminho deles.

### E há tráfego real neles

Contagem por origem nos logs do NPM (3.668 linhas):

| hostname | via Cloudflare | direto |
|---|---|---|
| allvoice | 3.156 | 18 (todos de `172.18.0.1`, a ponte do Docker — interno) |
| pulse | 202 | 2 (o próprio IP da VM: meus testes) |
| publi | 82 | 0 |
| hub | 2 | 0 |
| enable | 2 | 0 |
| **supabase-metas** | **0** | **134, de IPs externos reais** |
| **metas** | **0** | **12** |
| **evolution** | **0** | **5** |

`supabase-metas` tem 134 acessos externos legítimos que **não passam pelo
Cloudflare**. Bloquear derrubaria todos.

### E quebraria a renovação de certificado, em silêncio

Três certificados são Let's Encrypt e renovam por validação HTTP na porta 80,
feita **por IPs da Let's Encrypt** — que não são do Cloudflare:

| certificado | vence |
|---|---|
| evolution.alloyal.com.br | 14/09/2026 |
| supabase-metas.alloyal.com.br | 01/10/2026 |
| metas.alloyal.com.br | 12/10/2026 |

Uma regra de firewall na 80 não daria erro nenhum no dia. Ela quebraria a
renovação, e o sintoma apareceria semanas depois, como certificado vencido.

## A saída certa: Authenticated Origin Pulls (mTLS)

O Cloudflare apresenta um **certificado de cliente** ao falar com a origem. Quem
não tem esse certificado não completa o handshake. É **por proxy host**, então
vale só onde é declarado — os três diretos não são tocados.

### A ordem importa, e inverter derruba o site

1. **Painel do Cloudflare:** SSL/TLS → Origin Server → **Authenticated Origin
   Pulls → ON**.

   Isso é **inócuo sozinho**: faz o Cloudflare *oferecer* o certificado, e origem
   que não confere simplesmente ignora. Não afeta Publi, Radar, Enable, Allvoice
   nem Hub — nenhum deles exige o certificado.

2. **Só então**, trocar `optional` por `on` em
   `infra/proxy-pulse.advanced.conf`.

Fazer o 2 antes do 1 dá **400 em tudo, para todo mundo**.

### Onde está hoje

A sonda já está no ar, e **não bloqueia ninguém**: `ssl_verify_client optional`
pede o certificado e aceita a conexão de qualquer jeito. O resultado sai no
cabeçalho `X-Sonda-Mtls`:

```bash
curl -sI https://pulse.alloyal.com.br | grep -i x-sonda-mtls
```

- `NONE` → o passo 1 ainda não foi feito. É o estado em 02/08/2026.
- `SUCCESS` → o Cloudflare está mandando o certificado; pode trocar para `on`.

Conferido depois de ligar a sonda: os nove hostnames respondem igual, e o
navegador completa o handshake normalmente.

### Depois de trocar para `on`, o teste que prova

```bash
curl -k --resolve pulse.alloyal.com.br:443:144.33.13.117 https://pulse.alloyal.com.br
# esperado: erro de handshake TLS, não 200

curl -sI https://pulse.alloyal.com.br | head -1
# esperado: 200 — o caminho normal segue funcionando
```

## O que fica de fora, e por quê

Os três hostnames diretos continuam sem Cloudflare na frente. Isso é decisão
deles, não do Pulse, e mudar exige:

- ligar o proxy (nuvem laranja) no DNS de cada um;
- trocar o certificado de Let's Encrypt para Origin CA (o `metas` **já tem um**
  preparado no NPM, id 6, `metas-cf-origin`, e não está em uso);
- conferir se algum cliente deles depende de falar direto com a origem — o
  `supabase-metas` tem 134 acessos externos, e é preciso saber de quem são antes.

Enquanto isso não for feito, a porta dos fundos continua aberta **para eles**.
Fechá-la no Pulse não depende disso.
