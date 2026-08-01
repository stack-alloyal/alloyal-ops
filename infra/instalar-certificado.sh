#!/usr/bin/env bash
# Instala um Origin Certificate do Cloudflare no Nginx Proxy Manager.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE UM SCRIPT E NÃO `cp` PARA /data/custom_ssl:                        │
# │                                                                            │
# │ O NPM indexa os certificados no banco dele (`/data/database.sqlite`) e      │
# │ nomeia as pastas por ID — `custom_ssl/npm-{id}`. Copiar arquivo para lá     │
# │ sem a linha no banco cria um certificado que o NPM não enxerga: ele não     │
# │ aparece na lista, nenhum proxy host consegue selecioná-lo, e a config do    │
# │ nginx nunca o referencia.                                                  │
# │                                                                            │
# │ Isso já aconteceu nesta instalação ao contrário: existe `custom_ssl/npm-3`  │
# │ no disco cujo registro foi APAGADO do banco, e a config antiga do nginx     │
# │ ainda aponta para ele. Arquivo e banco fora de sincronia é um estado que    │
# │ ninguém percebe até um handshake falhar.                                   │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Uso:
#   bash infra/instalar-certificado.sh pulse.alloyal.com.br \
#        ~/pulse-origin.pem ~/pulse-origin.key
#
# A senha do NPM é lida sem eco e não fica no histórico do shell nem em variável
# de ambiente exportada.

set -euo pipefail

HOSTNAME_CERT="${1:?uso: $0 <hostname> <cert.pem> <chave.key>}"
ARQ_CERT="${2:?falta o caminho do certificado}"
ARQ_CHAVE="${3:?falta o caminho da chave}"
NPM_URL="${NPM_URL:-http://127.0.0.1:81}"

for f in "$ARQ_CERT" "$ARQ_CHAVE"; do
  [ -r "$f" ] || { echo "não consigo ler $f"; exit 1; }
done

# ── Confere ANTES de enviar: par que não casa é o erro mais comum, e o NPM
#    aceita o upload e só falha no handshake, horas depois.
echo "── conferindo o par certificado/chave"
MOD_CERT=$(openssl x509 -noout -modulus -in "$ARQ_CERT" | openssl md5)
MOD_CHAVE=$(openssl rsa -noout -modulus -in "$ARQ_CHAVE" 2>/dev/null | openssl md5 ||
            openssl ec  -noout -text    -in "$ARQ_CHAVE" 2>/dev/null | openssl md5)
if [ "$MOD_CERT" != "$MOD_CHAVE" ]; then
  echo "✗ o certificado e a chave NÃO são um par."
  echo "  O NPM aceitaria o upload e o erro só apareceria no handshake."
  exit 1
fi

# ── E que o certificado cobre o hostname. Foi exatamente este o defeito que
#    derruba o `hub` sob Full (Strict): certificado válido, hostname errado.
SAN=$(openssl x509 -noout -ext subjectAltName -in "$ARQ_CERT" | grep -oE 'DNS:[^,]+' | sed 's/DNS://' | tr -d ' ')
if ! echo "$SAN" | grep -qxE "$(echo "$HOSTNAME_CERT" | sed 's/\./\\./g')|\*\.$(echo "${HOSTNAME_CERT#*.}" | sed 's/\./\\./g')"; then
  echo "✗ o certificado NÃO cobre $HOSTNAME_CERT."
  echo "  Ele cobre: $(echo "$SAN" | tr '\n' ' ')"
  echo "  Sob Full (Strict) o Cloudflare valida o hostname e devolve 526."
  exit 1
fi

EMISSOR=$(openssl x509 -noout -issuer -in "$ARQ_CERT")
VALIDADE=$(openssl x509 -noout -enddate -in "$ARQ_CERT" | sed 's/notAfter=//')
echo "   emissor:  ${EMISSOR:0:70}"
echo "   cobre:    $(echo "$SAN" | tr '\n' ' ')"
echo "   expira:   $VALIDADE"

# ── Autenticação. `read -s` não ecoa, e a senha não vira variável exportada.
read -rp "e-mail do admin do NPM [stack@alloyal.com.br]: " NPM_EMAIL
NPM_EMAIL="${NPM_EMAIL:-stack@alloyal.com.br}"
read -rsp "senha do NPM: " NPM_SENHA
echo

TOKEN=$(curl -s -X POST "$NPM_URL/api/tokens" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"identity":"%s","secret":"%s"}' "$NPM_EMAIL" "$NPM_SENHA")" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
unset NPM_SENHA

[ -n "$TOKEN" ] || { echo "✗ não autenticou no NPM. Confira e-mail e senha."; exit 1; }
echo "── autenticado"

# ── Cria o registro. `provider: other` é o que o NPM chama de "Custom".
ID=$(curl -s -X POST "$NPM_URL/api/nginx/certificates" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(printf '{"provider":"other","nice_name":"%s Origin (Cloudflare)"}' "$HOSTNAME_CERT")" |
  sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)

[ -n "$ID" ] || { echo "✗ não criou o registro do certificado."; exit 1; }
echo "── registro criado: id $ID"

# ── Sobe os arquivos. O NPM grava em /data/custom_ssl/npm-$ID e valida o par.
RESP=$(curl -s -X POST "$NPM_URL/api/nginx/certificates/$ID/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "certificate=@$ARQ_CERT" \
  -F "certificate_key=@$ARQ_CHAVE")

if echo "$RESP" | grep -q '"error"'; then
  echo "✗ o NPM recusou os arquivos:"
  echo "$RESP" | head -c 400
  echo
  echo "  O registro id $ID ficou órfão — apague-o na tela para não virar o mesmo"
  echo "  descompasso banco/arquivo que já existe nesta instalação."
  exit 1
fi

echo "── arquivos enviados"
sudo docker exec npm sh -c "ls -la /data/custom_ssl/npm-$ID" 2>/dev/null | sed 's/^/   /'

cat <<FIM

Certificado id $ID instalado para $HOSTNAME_CERT.

Falta ligar a um proxy host:
  1. NPM → Hosts → Proxy Hosts → Add Proxy Host
     Domain: $HOSTNAME_CERT   Forward: web-internal  porta 3000  (esquema http)
  2. Aba SSL → escolha "$HOSTNAME_CERT Origin (Cloudflare)"
     Marque Force SSL e HTTP/2.
  3. Aba Advanced → cole infra/proxy-pulse.advanced.conf, TROCANDO
     SUBSTITUIR_PELO_MESMO_VALOR_DE_PULSE_PROXY_SECRET pelo valor de
     PULSE_PROXY_SECRET em infra/.env.

APAGUE os arquivos depois — a chave privada vale 15 anos:
  shred -u $ARQ_CERT $ARQ_CHAVE
FIM
