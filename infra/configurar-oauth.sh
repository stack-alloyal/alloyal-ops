#!/usr/bin/env bash
# Gera infra/oauth2.env a partir do client OAuth do Google.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE UM SCRIPT PARA TRÊS LINHAS:                                        │
# │                                                                            │
# │ O `OAUTH2_PROXY_COOKIE_SECRET` precisa ter 16, 24 ou 32 BYTES. O reflexo    │
# │ de quem gera segredo é `openssl rand -base64 32`, que dá 44 caracteres — e  │
# │ o oauth2-proxy morre na partida com erro de AES, numa mensagem que não diz  │
# │ "o tamanho está errado". É armadilha documentada no CLAUDE.md da casa.      │
# │                                                                            │
# │ Aqui o cookie secret é gerado com o tamanho certo e conferido antes de      │
# │ gravar. Os dois valores que só você tem entram por prompt, sem eco e sem    │
# │ passar pelo histórico do shell.                                            │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Uso: bash infra/configurar-oauth.sh

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
ARQ="$RAIZ/infra/oauth2.env"

if [ -e "$ARQ" ]; then
  echo "$ARQ já existe."
  perguntar R "sobrescrever? [s/N] "
  [ "$R" = "s" ] || [ "$R" = "S" ] || exit 1
fi

echo "Console do Google → APIs e Serviços → Credenciais → Criar credenciais"
echo "  → ID do cliente OAuth → Aplicativo da Web"
echo "  Nome:  Alloyal Pulse"
echo "  URI de redirecionamento autorizado:"
echo "     https://pulse.alloyal.com.br/oauth2/callback"
echo

perguntar CLIENT_ID "Client ID: "
perguntar CLIENT_SECRET "Client Secret: " -s
echo

# ── Validações que evitam descobrir o erro na partida do contêiner
[ -n "$CLIENT_ID" ] || { echo "✗ Client ID vazio"; exit 1; }
[ -n "$CLIENT_SECRET" ] || { echo "✗ Client Secret vazio"; exit 1; }

case "$CLIENT_ID" in
  *.apps.googleusercontent.com) ;;
  *) echo "✗ o Client ID do Google termina em .apps.googleusercontent.com"
     echo "  Recebi: ${CLIENT_ID:0:24}…"
     exit 1;;
esac

# O projeto tem que ser o mesmo dos outros produtos — client de outro projeto
# autentica, mas contra outra base de usuários, e o sintoma é "e-mail não autorizado"
# para gente que existe.
PROJETO_ESPERADO=59783477182
case "$CLIENT_ID" in
  "$PROJETO_ESPERADO"-*) ;;
  *) echo "⚠ este client é do projeto $(printf '%s' "$CLIENT_ID" | cut -d- -f1),"
     echo "  e os outros produtos usam o $PROJETO_ESPERADO."
     perguntar R "  Seguir assim mesmo? [s/N] "
     [ "$R" = "s" ] || [ "$R" = "S" ] || exit 1;;
esac

# ── O cookie secret, com o tamanho que o oauth2-proxy aceita.
COOKIE=$(openssl rand -hex 16)   # 32 caracteres = 16 bytes de entropia hex
[ "${#COOKIE}" -eq 32 ] || { echo "✗ cookie secret saiu com ${#COOKIE} caracteres"; exit 1; }

umask 077
cat > "$ARQ" <<FIM
# oauth2-proxy da superfície interna do Pulse. NÃO versionar.
# Gerado por infra/configurar-oauth.sh
#
# O COOKIE_SECRET tem 32 caracteres (16 bytes). Se algum dia for regerado à mão,
# use \`openssl rand -hex 16\`. Com \`rand -base64 32\` são 44 caracteres, e o
# oauth2-proxy morre na partida com erro de AES que não menciona tamanho.
OAUTH2_PROXY_CLIENT_ID=$CLIENT_ID
OAUTH2_PROXY_CLIENT_SECRET=$CLIENT_SECRET
OAUTH2_PROXY_COOKIE_SECRET=$COOKIE
FIM
unset CLIENT_SECRET
chmod 600 "$ARQ"

echo "── $ARQ gerado (600, não versionado)"
echo
echo "Suba o oauth2-proxy:"
echo "   cd infra && docker compose up -d oauth2-proxy-pulse"
echo
echo "E confira que ele subiu de verdade — ele morre na partida quando o cookie"
echo "secret tem tamanho errado, e o compose reporta 'Started' antes disso:"
echo "   docker logs oauth2-proxy-pulse 2>&1 | tail -5"
