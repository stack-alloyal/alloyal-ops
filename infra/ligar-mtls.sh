#!/usr/bin/env bash
# Liga o Authenticated Origin Pulls (mTLS) no proxy host do Pulse.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ RODE SÓ DEPOIS DE LIGAR NO PAINEL DO CLOUDFLARE:                           │
# │   SSL/TLS → Origin Server → Authenticated Origin Pulls → ON                │
# │                                                                            │
# │ Ligar aqui antes dá 400 em TUDO, para todo mundo — o nginx passa a exigir  │
# │ um certificado que o Cloudflare ainda não manda.                          │
# │                                                                            │
# │ O script CONFERE isso antes de mexer em qualquer coisa: se a sonda não     │
# │ responder SUCCESS, ele recusa e não altera nada.                          │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Sobre o medo legítimo de ligar no painel, que é de ZONA: em TLS o certificado
# de cliente só é transmitido quando o SERVIDOR o solicita. Origem que não
# configura `ssl_verify_client` nunca o recebe, e o handshake dela é idêntico com
# ou sem o interruptor. Medido nesta VM em 02/08/2026 — `publi`, `hub`, `enable`,
# `allvoice` e `radar` NÃO pedem certificado de cliente. Ligar não tem como
# quebrá-las, nem elas nem aplicação fora da VM que esteja no mesmo estado.
#
# Isto NÃO substitui o allowlist de faixas do Cloudflare — soma. O allowlist
# confia numa lista de IPs; o mTLS confia numa chave privada que só o Cloudflare
# tem. Quem quiser passar precisa furar as duas.
#
# Uso: bash infra/ligar-mtls.sh

set -euo pipefail

HOST="${HOST:-pulse.alloyal.com.br}"
CONTEINER="${CONTEINER:-npm}"
CONF="/data/nginx/proxy_host/8.conf"
CA="/data/cloudflare/origin-pull-ca.pem"
BACKUP="$CONF.antes-mtls-$(date +%Y%m%d-%H%M%S)"

echo "── a CA do Cloudflare está no lugar?"
docker exec "$CONTEINER" test -s "$CA" || {
  echo "✗ $CA não existe. Baixe:"
  echo "    curl -fsS https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem -o /tmp/ca.pem"
  echo "    docker exec $CONTEINER mkdir -p /data/cloudflare"
  echo "    docker cp /tmp/ca.pem $CONTEINER:$CA"
  exit 1; }
echo "   ok"

# ── A checagem que impede derrubar o site ────────────────────────────────────
# A sonda precisa estar no ar (`ssl_verify_client optional` + o cabeçalho) e
# responder SUCCESS. `NONE` significa que o painel ainda não foi ligado.
echo "── o Cloudflare já manda o certificado de cliente?"
SONDA=$(curl -sI --max-time 15 "https://$HOST" | grep -i '^x-sonda-mtls' | tr -d '\r' | sed 's/.*: *//' || true)
case "$SONDA" in
  SUCCESS) echo "   SUCCESS — pode ligar";;
  NONE)    echo "✗ NONE: o Cloudflare NÃO está mandando certificado."
           echo "  Ligue primeiro em SSL/TLS → Origin Server → Authenticated Origin Pulls."
           echo "  NADA foi alterado."; exit 1;;
  "")      echo "✗ não achei o cabeçalho X-Sonda-Mtls."
           echo "  A sonda precisa estar ativa para este script poder decidir:"
           echo "    ssl_verify_client optional;"
           echo "    add_header X-Sonda-Mtls \$ssl_client_verify always;"
           echo "  NADA foi alterado."; exit 1;;
  *)       echo "✗ a sonda respondeu '$SONDA', que não é SUCCESS. NADA foi alterado."; exit 1;;
esac

echo "── backup: $BACKUP"
docker exec "$CONTEINER" cp "$CONF" "$BACKUP"

docker exec -i "$CONTEINER" python3 - "$CONF" <<'PY'
import re, sys
c = sys.argv[1]
s = open(c, encoding='utf-8').read()
if 'ssl_verify_client on;' in s:
    print('   já estava ligado'); raise SystemExit(0)
novo = s.replace('ssl_verify_client optional;', 'ssl_verify_client on;')
# O cabeçalho da sonda sai junto: ele existia para decidir a hora de ligar.
novo = re.sub(r'\n?[ \t]*add_header X-Sonda-Mtls[^\n]*\n', '\n', novo)
if 'ssl_verify_client on;' not in novo:
    print('   ✗ não achei `ssl_verify_client optional;` para trocar'); raise SystemExit(1)
open(c, 'w', encoding='utf-8').write(novo)
print('   trocado para `on`, sonda removida')
PY

reverter() {
  echo "── revertendo"
  docker exec "$CONTEINER" cp "$BACKUP" "$CONF"
  docker exec "$CONTEINER" nginx -s reload
  sleep 2
  echo "   depois de reverter: HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$HOST")"
}

if ! docker exec "$CONTEINER" nginx -t >/dev/null 2>&1; then
  echo "✗ nginx -t falhou"; reverter; exit 1
fi
docker exec "$CONTEINER" nginx -s reload
sleep 3

# ── A prova. Os DOIS têm que valer, senão volta atrás sozinho.
IP=$(curl -s --max-time 10 https://api.ipify.org)
NORMAL=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$HOST")
FUNDOS=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$HOST:443:$IP" "https://$HOST" || echo 000)

echo
echo "   caminho normal:      HTTP $NORMAL   (tem que ser 200)"
echo "   direto no IP:        HTTP $FUNDOS   (000 = handshake recusado, que é o certo)"

if [ "$NORMAL" = "200" ]; then
  echo
  echo "✓ mTLS ligado. Agora são DUAS camadas: allowlist de faixas + certificado."
  echo "  Backup em $BACKUP — apague quando não fizer mais falta."
else
  echo
  echo "✗ o caminho normal parou de responder 200."
  reverter
  exit 1
fi
