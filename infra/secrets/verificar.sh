#!/usr/bin/env bash
# Portão dos segredos: recusa placeholder cifrado e valor curto demais.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ Existe por um estado real e perigoso: cinco segredos estavam no SOPS com o  │
# │ valor literal "trocar". Cifrados. O arquivo mostrava                       │
# │ `PULSE_PROXY_SECRET: ENC[AES256_GCM,data:...]` — que se lê como "há um      │
# │ segredo aqui" — e o conteúdo era uma palavra de dicionário.                │
# │                                                                            │
# │ O pior deles é o PULSE_PROXY_SECRET: ele é a PROVA de que a requisição      │
# │ passou pelo proxy. Valendo "trocar", qualquer contêiner na VM forja o       │
# │ cabeçalho de identidade e entra como quem quiser.                          │
# │                                                                            │
# │ Cifrar não valida. Este script valida.                                     │
# └───────────────────────────────────────────────────────────────────────────┘
#
# Uso: bash infra/secrets/verificar.sh
# Requer: sops + a chave age em SOPS_AGE_KEY_FILE.

set -euo pipefail

ARQUIVO="${1:-infra/secrets/pulse.env.sops.yaml}"

# Chaves internas: nós geramos, então não há desculpa para estarem fracas.
# Tamanho mínimo generoso — 32 é o que `openssl rand -base64 32` dá depois de limpar.
declare -A MINIMO=(
  [POSTGRES_PULSE_PASSWORD]=24
  [REDIS_PULSE_PASSWORD]=24
  [PULSE_API_PASSWORD]=24
  [PULSE_PORTAL_PASSWORD]=24
  [PULSE_WORKER_PASSWORD]=24
  [PULSE_PROXY_SECRET]=32
  [PULSE_CHAVE_MESTRA]=44
)

# Chaves EXTERNAS: podem estar vazias legitimamente (esperando acesso de terceiro).
# Vazio é estado declarado; placeholder é armadilha. A distinção é o ponto.
EXTERNAS='REPLICA_URL|HUBSPOT_|CLEVERTAP_|OMIE_|EVOLUTION_|SMTP_URL|GOOGLE_'

PLACEHOLDER='^(trocar|troque|change|changeme|placeholder|substituir|senha|password|secret|xxx+|todo|fixme|test|teste)$'

falhas=0

for chave in "${!MINIMO[@]}"; do
  valor=$(sops -d --extract "[\"$chave\"]" "$ARQUIVO" 2>/dev/null || echo '')
  minimo=${MINIMO[$chave]}

  if [ -z "$valor" ]; then
    echo "✗ $chave está VAZIA — é chave interna, tem que ter valor"
    falhas=$((falhas + 1))
  elif echo "$valor" | grep -qiE "$PLACEHOLDER"; then
    # A mensagem NÃO repete o valor: este script roda em CI, e log com segredo
    # dentro é vazamento — mesmo sendo um placeholder hoje.
    echo "✗ $chave é PLACEHOLDER — cifrado, mas é palavra de dicionário"
    falhas=$((falhas + 1))
  elif [ "${#valor}" -lt "$minimo" ]; then
    echo "✗ $chave tem ${#valor} caracteres, mínimo $minimo"
    falhas=$((falhas + 1))
  fi
done

# As externas: placeholder também é recusado, mas vazio passa.
for linha in $(sops -d --output-type dotenv "$ARQUIVO" 2>/dev/null | grep -E "^($EXTERNAS)" || true); do
  chave="${linha%%=*}"
  valor="${linha#*=}"
  [ -z "$valor" ] && continue
  if echo "$valor" | grep -qiE "$PLACEHOLDER"; then
    echo "✗ $chave é PLACEHOLDER — deixe VAZIA enquanto o acesso não existir"
    falhas=$((falhas + 1))
  fi
done

if [ "$falhas" -gt 0 ]; then
  echo
  echo "$falhas problema(s). Gere valor forte com:"
  echo "  openssl rand -base64 32 | tr -d '=+/' | cut -c1-32"
  echo "e grave com:  sops --set '[\"CHAVE\"] \"valor\"' $ARQUIVO"
  exit 1
fi

echo "ok — nenhum placeholder, nenhum valor curto."
