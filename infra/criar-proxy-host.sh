#!/usr/bin/env bash
# Cria o proxy host de pulse.alloyal.com.br no Nginx Proxy Manager.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE UM SCRIPT E NÃO A TELA:                                            │
# │                                                                            │
# │ O Advanced Config precisa do valor real de PULSE_PROXY_SECRET no lugar do  │
# │ placeholder. Colar isso à mão significa copiar um segredo de 64 caracteres │
# │ do `.env` para um campo de textarea — e um caractere a mais ou a menos dá  │
# │ 401 em TUDO, com a aplicação dizendo apenas "não comprovou ter passado     │
# │ pelo proxy". Esta VM já perdeu tempo com erro de um byte em PEM colado.    │
# │                                                                            │
# │ Aqui a substituição é feita pelo script, a partir do mesmo `.env` que a    │
# │ aplicação lê. Os dois lados não têm como divergir.                        │
# └───────────────────────────────────────────────────────────────────────────┘
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE O FORWARD É `web-internal` E NÃO `oauth2-proxy-pulse`:             │
# │                                                                            │
# │ Os outros produtos da casa encaminham para o oauth2-proxy, que fala com o  │
# │ app (`--upstream=http://app:3000`). O Pulse não pode: a aplicação exige o  │
# │ cabeçalho `X-Pulse-Proxy-Secret` como prova de ter passado pelo proxy, e o │
# │ oauth2-proxy não injeta cabeçalho estático arbitrário — só o nginx injeta. │
# │                                                                            │
# │ Por isso o `oauth2-proxy-pulse` roda com `--upstream=static://200`: ele só │
# │ responde à pergunta "esta sessão está autenticada?" que o `auth_request`   │
# │ do Advanced Config faz. Quem encaminha ao app é o nginx.                   │
# │                                                                            │
# │ Copiar o padrão dos vizinhos aqui daria 401 em tudo.                       │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Uso: sudo bash infra/criar-proxy-host.sh

set -euo pipefail

# ── Leitura de entrada, com ou sem terminal ───────────────────────────────────
# `</dev/tty` falha com "No such device or address" quando o script roda sem
# terminal — por exemplo pelo prefixo `!` do Claude Code, ou em pipe. Acontece
# DEPOIS de o script já ter impresso instruções, então parece que ele funcionou e
# só travou no fim.
#
# Com TTY: lê do terminal, o que permite `cmd | bash` sem consumir o pipe.
# Sem TTY: cai para stdin, e a mensagem diz como passar os valores.
# O teste TEM que ABRIR o dispositivo. `[ -e ]` e `[ -r ]` passam mesmo sem terminal
# de controle — o nó existe e as permissões batem — e só o open() falha com ENXIO.
# Foi assim que a primeira versão deste fallback não funcionou.
if : 2>/dev/null </dev/tty; then   # o 2>/dev/null vem ANTES: bash aplica redireção da esquerda para a direita, e </dev/tty falharia antes de o silenciamento valer
  ENTRADA=/dev/tty
else
  ENTRADA=/dev/stdin
fi

perguntar() {  # perguntar <variável> <rótulo> [-s]
  local __var="$1" __rotulo="$2" __oculto="${3:-}" __valor
  if [ "$__oculto" = "-s" ]; then
    read -rsp "$__rotulo" __valor <"$ENTRADA" || {
      echo; echo "✗ não consegui ler a entrada."; return 1; }
    echo
  else
    read -rp "$__rotulo" __valor <"$ENTRADA" || {
      echo; echo "✗ não consegui ler a entrada."; return 1; }
  fi
  printf -v "$__var" '%s' "$__valor"
}

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-pulse.alloyal.com.br}"
DESTINO="${DESTINO:-web-internal}"
PORTA="${PORTA:-3000}"
CONF="$RAIZ/infra/proxy-pulse.advanced.conf"
ENV="$RAIZ/infra/.env"
NPM_URL="${NPM_URL:-http://127.0.0.1:81}"

[ -r "$CONF" ] || { echo "não achei $CONF"; exit 1; }
[ -r "$ENV" ]  || { echo "não achei $ENV — rode: make secrets-decrypt"; exit 1; }

SEGREDO=$(grep '^PULSE_PROXY_SECRET=' "$ENV" | cut -d= -f2-)
[ -n "$SEGREDO" ] || { echo "PULSE_PROXY_SECRET vazio em $ENV"; exit 1; }

# Rotação em curso? O `.env` aceita lista separada por vírgula, mas o nginx injeta UM
# valor. Nesse caso o certo é o NOVO — o velho continua aceito pela aplicação até o
# passo final da rotação.
if printf '%s' "$SEGREDO" | grep -q ','; then
  SEGREDO="${SEGREDO##*,}"
  echo "── rotação em curso: injetando o ÚLTIMO valor da lista"
fi

# ── O app está de pé e alcançável de onde o NPM vai chamar?
echo "── o NPM alcança $DESTINO:$PORTA?"
CODIGO=$(docker exec npm curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
  -H "x-pulse-proxy-secret: $SEGREDO" -H 'x-auth-request-email: teste@alloyal.com.br' \
  "http://$DESTINO:$PORTA/" 2>/dev/null || echo 000)
case "$CODIGO" in
  200|401|403) echo "   ok (HTTP $CODIGO — o app respondeu)";;
  000) echo "✗ o NPM não conseguiu conectar em $DESTINO:$PORTA."
       echo "  Se o contêiner está de pé, confira o endereço de bind — o Next"
       echo "  standalone usa \$HOSTNAME e num contêiner em duas redes escuta só numa:"
       echo "    docker exec pulse-web-internal sh -c 'cat /proc/net/tcp' | head -3"
       echo "  Precisa aparecer 00000000:0BB8 (0.0.0.0:3000)."
       exit 1;;
  *) echo "   ⚠ HTTP $CODIGO — inesperado, mas segue";;
esac

# ── O oauth2-proxy existe? Sem ele o auth_request devolve 502 em tudo.
if ! docker ps --format '{{.Names}}' | grep -qx oauth2-proxy-pulse; then
  echo
  echo "⚠ oauth2-proxy-pulse NÃO está rodando."
  echo "  O Advanced Config faz auth_request para ele; sem ele, TUDO responde 502."
  echo "  Falta infra/oauth2.env com o client OAuth do Google (C-07)."
  perguntar R "  Criar o proxy host assim mesmo? [s/N] "
  [ "$R" = "s" ] || [ "$R" = "S" ] || exit 1
fi

perguntar NPM_EMAIL "e-mail do admin do NPM [stack@alloyal.com.br]: "
NPM_EMAIL="${NPM_EMAIL:-stack@alloyal.com.br}"
perguntar NPM_SENHA "senha do NPM: " -s
echo

TOKEN=$(curl -s -X POST "$NPM_URL/api/tokens" -H 'Content-Type: application/json' \
  -d "$(printf '{"identity":"%s","secret":"%s"}' "$NPM_EMAIL" "$NPM_SENHA")" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
unset NPM_SENHA
[ -n "$TOKEN" ] || { echo "✗ não autenticou no NPM."; exit 1; }

# ── O certificado do host, pelo nome. Errar aqui é apontar para o certificado de
#    outro produto — que é o defeito que derruba o `hub` sob Full (Strict).
CERT_ID=$(curl -s "$NPM_URL/api/nginx/certificates" -H "Authorization: Bearer $TOKEN" |
  tr '}' '\n' | grep -F "$HOST" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | tail -1)
[ -n "$CERT_ID" ] || { echo "✗ não achei certificado para $HOST. Rode instalar-certificado.sh antes."; exit 1; }
echo "── certificado id $CERT_ID"

# O Advanced Config com o segredo real. `printf %s` e não echo, para não interpretar
# barra invertida no conteúdo. O `sed` é seguro porque PULSE_PROXY_SECRET é hex — se
# um dia virar base64, `/` e `&` quebrariam a substituição.
AVANCADO=$(printf '%s' "$(cat "$CONF")" |
  sed "s|SUBSTITUIR_PELO_MESMO_VALOR_DE_PULSE_PROXY_SECRET|$SEGREDO|")

if printf '%s' "$AVANCADO" | grep -q SUBSTITUIR_PELO; then
  echo "✗ o placeholder não foi substituído — o formato do arquivo mudou?"
  exit 1
fi

RESP=$(curl -s -X POST "$NPM_URL/api/nginx/proxy-hosts" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(AVANCADO="$AVANCADO" python3 - "$HOST" "$DESTINO" "$PORTA" "$CERT_ID" <<'PY'
import json, sys, os
host, destino, porta, cert = sys.argv[1:5]
print(json.dumps({
    "domain_names": [host],
    "forward_scheme": "http",
    "forward_host": destino,
    "forward_port": int(porta),
    "certificate_id": int(cert),
    "ssl_forced": True,
    "http2_support": True,
    "hsts_enabled": False,
    "block_exploits": True,
    "caching_enabled": False,
    "allow_websocket_upgrade": True,
    "advanced_config": os.environ["AVANCADO"],
    "locations": [],
    "meta": {},
}))
PY
)")

if printf '%s' "$RESP" | grep -q '"error"'; then
  echo "✗ o NPM recusou:"
  printf '%s\n' "$RESP" | head -c 500; echo
  exit 1
fi

ID=$(printf '%s' "$RESP" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
echo "── proxy host criado: id $ID"
echo
echo "Confira agora:"
echo "  curl -sI https://$HOST | head -1"
echo "     302 → SSO funcionando"
echo "     502 → falta o oauth2-proxy-pulse (infra/oauth2.env)"
echo "     525 → o nginx não recarregou; docker exec npm nginx -s reload"
