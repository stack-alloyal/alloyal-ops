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

## Segunda camada: mTLS, armado e à espera de um clique

Mais forte que o allowlist e **soma** a ele: o allowlist confia numa lista de IPs,
o mTLS confia numa chave privada que só o Cloudflare tem. Quem quiser passar
precisa furar as duas.

**Está em `optional`** — pede o certificado e aceita a conexão de qualquer jeito,
sem bloquear ninguém. Falta um clique:

> Cloudflare → SSL/TLS → Origin Server → **Authenticated Origin Pulls → ON**

Depois disso, um comando liga:

```bash
bash infra/ligar-mtls.sh
```

Ele **recusa se a sonda não disser SUCCESS**, faz backup, testa o nginx, e
**reverte sozinho** se o caminho normal parar de responder 200. Testado com o
painel desligado: recusou e não alterou nada.

### O medo de ligar no painel, medido

O interruptor é de zona, e a zona atende aplicações fora desta VM. A preocupação é
legítima, mas o risco é nulo, e dá para demonstrar:

**Em TLS, o certificado de cliente só é transmitido quando o SERVIDOR o
solicita.** Origem que não configura `ssl_verify_client` nunca o recebe, e o
handshake dela é byte a byte idêntico com ou sem o interruptor.

Conferido em 02/08/2026, perguntando a cada origem se ela pede certificado:

| hostname | pede certificado de cliente? |
|---|---|
| publi | não |
| hub | não |
| enable | não |
| allvoice | não |
| radar | não |
| **pulse** | **sim** (é o único configurado para isso) |

Ligar no painel não tem como quebrar quem não pede — nem nesta VM nem fora dela.

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
