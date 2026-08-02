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

## A saída escolhida: allowlist DENTRO do proxy host

`allow`/`deny` no server block do Pulse. Vale **só para ele** — os três diretos
não são tocados, e nada fora da VM é afetado.

```nginx
include /data/cloudflare/faixas.conf;   # allow das faixas + deny all
```

A lista é gerada por `infra/faixas-cloudflare.sh` e mora fora da configuração do
proxy host de propósito: as faixas do Cloudflare mudam algumas vezes por ano, e
atualizar passa a ser rodar o script — sem reabrir o campo onde vive o segredo.

O script **recusa gravar lista suspeita**: vazia, curta demais, sem as faixas
conhecidas ou com HTML no lugar do texto. Uma resposta ruim do Cloudflare não pode
virar `deny all` sozinha, que é o modo de falha que derruba o site.

Se o arquivo sumir, o `include` falha e o nginx **não recarrega** — melhor recusar
a recarga do que subir sem a proteção.

### Provado em 02/08/2026, depois de aplicar

| hostname | pelo caminho normal | direto no IP |
|---|---|---|
| **pulse** | **200** | **403 ← fechado** |
| hub | 307 | 307 |
| publi | 200 | 200 |
| radar | 403 | 403 |
| enable | 200 | 200 |
| allvoice | 200 | 200 |
| metas | 307 | 307 |
| evolution | 200 | 200 |
| supabase-metas | 401 | 401 |

Só o Pulse mudou. Os oito outros respondem exatamente como antes, pelos dois
caminhos.

### Manutenção

`sudo bash infra/faixas-cloudflare.sh` quando o Cloudflare publicar faixa nova. O
sintoma de lista velha é tráfego **legítimo** levando 403 — vale conferir ao
investigar acesso negado inexplicável.

## Por que NÃO Authenticated Origin Pulls (mTLS)

O Cloudflare apresenta um **certificado de cliente** ao falar com a origem. Quem
não tem esse certificado não completa o handshake. É **por proxy host**, então
vale só onde é declarado — os três diretos não são tocados.

O interruptor é de **ZONA**, e a zona `alloyal.com.br` atende aplicações **fora
desta VM**, sem visibilidade sobre elas. Ligar seria decidir por sistemas que não
se conhece — e a decisão foi não fazer isso.

Fica como **segunda camada** para quando/se der: é mais forte que o allowlist,
porque não confia numa lista de IPs e sim numa chave privada que só o Cloudflare
tem. A CA já está em `/data/cloudflare/origin-pull-ca.pem`.

### Se um dia der para ligar, a ordem importa e inverter derruba o site

1. **Painel do Cloudflare:** SSL/TLS → Origin Server → **Authenticated Origin
   Pulls → ON**.

   Isso é **inócuo sozinho**: faz o Cloudflare *oferecer* o certificado, e origem
   que não confere simplesmente ignora. Não afeta Publi, Radar, Enable, Allvoice
   nem Hub — nenhum deles exige o certificado.

2. **Só então**, trocar `optional` por `on` em
   `infra/proxy-pulse.advanced.conf`.

Fazer o 2 antes do 1 dá **400 em tudo, para todo mundo**.

### Como conferir, no dia, se o painel já foi ligado

Sem bloquear ninguém: `ssl_verify_client optional` PEDE o certificado e aceita a
conexão de qualquer jeito, e `add_header X-Sonda-Mtls $ssl_client_verify always;`
mostra o resultado.

```bash
curl -sI https://pulse.alloyal.com.br | grep -i x-sonda-mtls
```

`NONE` = painel desligado. `SUCCESS` = pode trocar por `on`.

Essa sonda **rodou em 02/08/2026 e respondeu NONE**; foi removida depois, porque o
allowlist já resolveu e ela adicionava um cabeçalho em toda resposta e um pedido
de certificado em todo handshake.

### Depois de trocar para `on`, o teste que prova

```bash
curl -k --resolve pulse.alloyal.com.br:443:144.33.13.117 https://pulse.alloyal.com.br
# esperado: erro de handshake TLS — e não o 403 do allowlist, que é uma camada
# depois

curl -sI https://pulse.alloyal.com.br | head -1
# esperado: 200 — o caminho normal segue funcionando
```

## O que fica de fora, e por quê

Os três hostnames diretos continuam sem Cloudflare na frente. Isso é decisão
deles, não do Pulse, e mudar exige:

- ligar o proxy (nuvem laranja) no DNS de cada um — o que, de quebra, **para de
  publicar o IP da VM em DNS público**, que é hoje a forma mais fácil de alguém
  descobrir a origem. Isso não fecha porta nenhuma sozinho: quem já tem o IP,
  por histórico de DNS, continua tendo. Vale pelo que protege os três, não como
  substituto do allowlist;
- trocar o certificado de Let's Encrypt para Origin CA (o `metas` **já tem um**
  preparado no NPM, id 6, `metas-cf-origin`, e não está em uso);
- conferir se algum cliente deles depende de falar direto com a origem — o
  `supabase-metas` tem 134 acessos externos, e é preciso saber de quem são antes.

Enquanto isso não for feito, a porta dos fundos continua aberta **para eles**.
Fechá-la no Pulse não depende disso.
