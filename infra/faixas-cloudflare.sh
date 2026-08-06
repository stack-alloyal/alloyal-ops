#!/usr/bin/env bash
# Gera a lista de faixas do Cloudflare que o proxy host do Pulse aceita.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE ISTO EXISTE, E POR QUE NÃO É `ufw`:                                │
# │                                                                            │
# │ A origem responde quando chamada direto pelo IP, pulando WAF, rate limit e │
# │ proteção de DDoS do Cloudflare. Fechar isso com `ufw` derrubaria TRÊS      │
# │ serviços desta VM — `metas`, `evolution` e `supabase-metas` apontam direto │
# │ para o IP, sem Cloudflare no caminho, e um deles tem 134 acessos externos  │
# │ reais nos logs. Medições em `infra/porta-dos-fundos.md`.                   │
# │                                                                            │
# │ `allow`/`deny` DENTRO do server block valem só para aquele proxy host. Os  │
# │ três diretos não são tocados, e nada fora da VM é afetado.                 │
# └───────────────────────────────────────────────────────────────────────────┘
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ A LISTA MUDA. Não é frequente — algumas vezes por ano — mas quando muda, o │
# │ que acontece é tráfego LEGÍTIMO levando 403. Por isso a lista mora num     │
# │ arquivo próprio, incluído pelo proxy host: atualizar é rodar este script e │
# │ recarregar, sem tocar na configuração do host.                            │
# │                                                                            │
# │ O script RECUSA gravar uma lista suspeita — vazia, curta demais ou sem as  │
# │ faixas conhecidas. Uma resposta ruim do Cloudflare não pode virar `deny    │
# │ all` sozinho, que é o modo de falha que derruba o site.                   │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Uso: sudo bash infra/faixas-cloudflare.sh

set -euo pipefail

DESTINO="${DESTINO:-/data/cloudflare/faixas.conf}"
CONTEINER="${CONTEINER:-npm}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "── baixando as faixas publicadas"
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4 -o "$TMP/v4.txt"
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6 -o "$TMP/v6.txt"

N4=$(grep -c '/' "$TMP/v4.txt" || true)
N6=$(grep -c '/' "$TMP/v6.txt" || true)
echo "   $N4 faixas IPv4 · $N6 IPv6"

# ── As recusas. Cada uma existe porque o modo de falha é derrubar o site.
[ "$N4" -ge 10 ] || { echo "✗ só $N4 faixas IPv4 — resposta suspeita, não gravo"; exit 1; }
[ "$N6" -ge 4 ]  || { echo "✗ só $N6 faixas IPv6 — resposta suspeita, não gravo"; exit 1; }

# Duas faixas que o Cloudflare publica desde sempre. Se sumirem as duas, o que
# veio não é a lista do Cloudflare — é página de erro, captcha ou redirecionamento.
for conhecida in 173.245.48.0/20 104.16.0.0/13; do
  grep -qxF "$conhecida" "$TMP/v4.txt" || { echo "✗ a lista não traz $conhecida — não gravo"; exit 1; }
done

if grep -qiE '<html|<!doctype' "$TMP/v4.txt" "$TMP/v6.txt"; then
  echo "✗ veio HTML no lugar da lista — não gravo"; exit 1
fi

{
  echo "# Gerado por infra/faixas-cloudflare.sh. Não editar à mão."
  echo "# Faixas publicadas em https://www.cloudflare.com/ips-v4 e /ips-v6."
  echo "#"
  echo "# Incluído pelo proxy host do Pulse, DENTRO do server block: vale só para"
  echo "# ele. Os hostnames que apontam direto para a VM não são afetados."
  echo
  awk 'NF {print "allow " $0 ";"}' "$TMP/v4.txt"
  awk 'NF {print "allow " $0 ";"}' "$TMP/v6.txt"
  echo
  echo "# A própria máquina, para diagnóstico de dentro da VM."
  echo "allow 127.0.0.1;"
  echo
  echo "# Tudo o mais é a porta dos fundos."
  echo "deny all;"
} > "$TMP/faixas.conf"

LINHAS=$(grep -c '^allow' "$TMP/faixas.conf")
[ "$LINHAS" -ge 15 ] || { echo "✗ só $LINHAS linhas de allow — não gravo"; exit 1; }

docker exec "$CONTEINER" mkdir -p "$(dirname "$DESTINO")"
docker cp "$TMP/faixas.conf" "$CONTEINER:$DESTINO"
echo "── $LINHAS faixas gravadas em $DESTINO"

if docker exec "$CONTEINER" nginx -t >/dev/null 2>&1; then
  docker exec "$CONTEINER" nginx -s reload
  echo "── nginx recarregado"
else
  echo "✗ nginx -t falhou DEPOIS de gravar. Rode para ver o erro:"
  echo "    docker exec $CONTEINER nginx -t"
  exit 1
fi

echo
echo "Confira agora — os dois têm que valer:"
echo "  curl -sI https://pulse.alloyal.com.br | head -1"
echo "     200 = o caminho normal segue funcionando"
echo "  curl -sk --resolve pulse.alloyal.com.br:443:\$(curl -s https://api.ipify.org) https://pulse.alloyal.com.br -o /dev/null -w '%{http_code}\\n'"
echo "     403 = a porta dos fundos fechou"
