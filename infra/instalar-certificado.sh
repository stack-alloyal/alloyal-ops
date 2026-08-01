#!/usr/bin/env bash
# Instala um Origin Certificate do Cloudflare no Nginx Proxy Manager.
#
# Segue a convenção da casa: os arquivos vivem em /etc/alloyal/origin-ca/ como
# <produto>.crt (644) e <produto>.key (600, root).
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE UM SCRIPT E NÃO `cp` PARA /data/custom_ssl:                        │
# │                                                                            │
# │ O NPM indexa os certificados no banco dele (`/data/database.sqlite`) e      │
# │ nomeia as pastas por ID — `custom_ssl/npm-{id}`. Arquivo sem a linha no     │
# │ banco cria um certificado que o NPM não enxerga: não aparece na lista,      │
# │ nenhum proxy host o seleciona, e a config do nginx nunca o referencia.      │
# │                                                                            │
# │ Esta instalação já tem esse estado ao contrário: existe `custom_ssl/npm-3`  │
# │ no disco cujo registro foi APAGADO do banco, e a config antiga do nginx     │
# │ ainda apontava para ele — foi o que me fez diagnosticar errado qual host    │
# │ quebrava sob Full (Strict).                                                │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Uso:
#   sudo bash infra/instalar-certificado.sh pulse
#   sudo bash infra/instalar-certificado.sh pulse pulse.alloyal.com.br   # se diferir
#
# Precisa de root: as chaves em /etc/alloyal/origin-ca são 600 root:root, e o
# upload é feito lendo direto de lá — sem cópia temporária, que seria uma janela
# a mais com a chave privada em disco legível.

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

PRODUTO="${1:?uso: sudo bash $0 <produto> [hostname]}"
HOST="${2:-$PRODUTO.alloyal.com.br}"
DIR=/etc/alloyal/origin-ca
CRT="$DIR/$PRODUTO.crt"
KEY="$DIR/$PRODUTO.key"
NPM_URL="${NPM_URL:-http://127.0.0.1:81}"

[ "$(id -u)" -eq 0 ] || { echo "rode com sudo: as chaves em $DIR são 600 root:root"; exit 1; }

for f in "$CRT" "$KEY"; do
  [ -s "$f" ] || { echo "✗ $f não existe ou está vazio"; exit 1; }
done

# ── As duas falhas que JÁ aconteceram nesta VM ────────────────────────────────
# `enable.key.bak-truncada` tinha 1703 bytes contra 1704 da boa — UM byte a menos.
# `radar.key.bak-espaco` tinha 1705 — um a mais. As duas com 28 linhas, igual à
# boa: contar linha não pega. Só pedir ao openssl para interpretar pega.
echo "── a chave é interpretável?"
if ! openssl pkey -in "$KEY" -noout 2>/dev/null; then
  echo "✗ $KEY não é uma chave válida."
  echo
  echo "  Esta VM já teve as duas causas, e ambas foram de UM byte:"
  echo "    · colagem truncada  — faltou um caractere no fim"
  echo "    · espaço a mais     — o terminal ou o editor acrescentou um"
  echo
  echo "  Confira: $(wc -c < "$KEY") bytes, $(wc -l < "$KEY") linhas."
  echo "  Uma chave RSA 2048 do Cloudflare Origin CA tem 1704 bytes e 28 linhas."
  echo "  Recole usando o heredoc com <<'PEM' (aspas!), que impede substituição."
  exit 1
fi
echo "   ok"

echo "── o certificado é interpretável?"
openssl x509 -in "$CRT" -noout 2>/dev/null || { echo "✗ $CRT não é um certificado válido"; exit 1; }
echo "   ok"

# ── O par casa? O NPM aceita um par que não casa e só falha no handshake.
echo "── certificado e chave são o mesmo par?"
MOD_CRT=$(openssl x509 -noout -modulus -in "$CRT" | openssl md5)
MOD_KEY=$(openssl rsa -noout -modulus -in "$KEY" 2>/dev/null | openssl md5 || echo 'ec')
if [ "$MOD_KEY" = 'ec' ]; then
  # Chave EC: compara a chave pública derivada, não o módulo.
  MOD_CRT=$(openssl x509 -noout -pubkey -in "$CRT" | openssl md5)
  MOD_KEY=$(openssl pkey -pubout -in "$KEY" | openssl md5)
fi
[ "$MOD_CRT" = "$MOD_KEY" ] || { echo "✗ o certificado e a chave NÃO são um par."; exit 1; }
echo "   ok"

# ── Cobre o hostname? É a causa de 526 sob Full (Strict), e já derruba um host
#    desta instalação: o `hub` serve um autoassinado marcado como PLACEHOLDER.
echo "── o certificado cobre $HOST?"
SAN=$(openssl x509 -noout -ext subjectAltName -in "$CRT" 2>/dev/null |
      grep -oE 'DNS:[^,]+' | sed 's/DNS://' | tr -d ' ')
ESCAPADO=$(printf '%s' "$HOST" | sed 's/\./\\./g')
CURINGA="\\*\\.$(printf '%s' "${HOST#*.}" | sed 's/\./\\./g')"
if ! printf '%s\n' "$SAN" | grep -qxE "$ESCAPADO|$CURINGA"; then
  echo "✗ NÃO cobre. Ele cobre: $(printf '%s' "$SAN" | tr '\n' ' ')"
  echo "  Sob Full (Strict) o Cloudflare valida o hostname e devolve 526."
  exit 1
fi
echo "   ok"

echo
echo "   emissor: $(openssl x509 -noout -issuer -in "$CRT" | cut -c1-72)"
echo "   cobre:   $(printf '%s' "$SAN" | tr '\n' ' ')"
echo "   expira:  $(openssl x509 -noout -enddate -in "$CRT" | sed 's/notAfter=//')"
echo

# ── Autenticação no NPM. `read -s` não ecoa e a senha não vira variável exportada.
perguntar NPM_EMAIL "e-mail do admin do NPM [stack@alloyal.com.br]: "
NPM_EMAIL="${NPM_EMAIL:-stack@alloyal.com.br}"
perguntar NPM_SENHA "senha do NPM: " -s
echo

TOKEN=$(curl -s -X POST "$NPM_URL/api/tokens" -H 'Content-Type: application/json' \
  -d "$(printf '{"identity":"%s","secret":"%s"}' "$NPM_EMAIL" "$NPM_SENHA")" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
unset NPM_SENHA
[ -n "$TOKEN" ] || { echo "✗ não autenticou no NPM."; exit 1; }
echo "── autenticado"

ID=$(curl -s -X POST "$NPM_URL/api/nginx/certificates" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(printf '{"provider":"other","nice_name":"%s Origin (Cloudflare)"}' "$HOST")" |
  sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
[ -n "$ID" ] || { echo "✗ não criou o registro."; exit 1; }
echo "── registro criado: id $ID"

RESP=$(curl -s -X POST "$NPM_URL/api/nginx/certificates/$ID/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "certificate=@$CRT" -F "certificate_key=@$KEY")

if printf '%s' "$RESP" | grep -q '"error"'; then
  echo "✗ o NPM recusou:"
  printf '%s\n' "$RESP" | head -c 400; echo
  echo "  Apague o registro id $ID na tela — senão vira o mesmo descompasso"
  echo "  banco/arquivo que já existe nesta instalação (npm-3)."
  exit 1
fi

echo "── enviado. Arquivos no NPM:"
docker exec npm sh -c "ls -la /data/custom_ssl/npm-$ID" 2>/dev/null | tail -3 | sed 's/^/   /'

cat <<FIM

Certificado id $ID instalado para $HOST.

Falta ligar ao proxy host:
  1. NPM → Proxy Hosts → Add Proxy Host
     Domain: $HOST · Forward: web-internal · porta 3000 · esquema http
  2. Aba SSL → "$HOST Origin (Cloudflare)" · Force SSL · HTTP/2
  3. Aba Advanced → cole infra/proxy-pulse.advanced.conf, TROCANDO
     SUBSTITUIR_PELO_MESMO_VALOR_DE_PULSE_PROXY_SECRET pelo PULSE_PROXY_SECRET
     de infra/.env

Os arquivos FICAM em $DIR — é a convenção da casa, e é deles que uma
reinstalação futura vai partir. Não apague.
FIM
