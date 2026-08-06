#!/usr/bin/env bash
#
# Backup do banco do Pulse.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ POR QUE ISTO EXISTE, escrito sem eufemismo: em 05/08/2026 eu apaguei 17     │
# │ registros do kickoff rodando um DELETE sem filtro contra a produção. Não     │
# │ havia backup, `archive_mode` estava off e o autovacuum já havia reclamado as  │
# │ linhas. A recuperação só foi possível lendo os bytes crus do WAL — o que     │
# │ funcionou por sorte: o segmento ainda não havia sido reciclado.              │
# │                                                                            │
# │ Sorte não é procedimento. Este script é.                                    │
# └───────────────────────────────────────────────────────────────────────────┘
#
# RECUSA escrever um dump suspeito, em vez de substituir o bom por lixo — mesmo
# princípio do `faixas-cloudflare.sh`: um backup que existe e está vazio é pior que
# nenhum, porque cria confiança falsa.
#
# Uso:  ./backup-banco.sh            (backup normal, para o cron)
#       ./backup-banco.sh --listar   (mostra o que existe)
set -euo pipefail

CONTEINER=postgres-pulse
BANCO=pulse
DESTINO="${PULSE_BACKUP_DIR:-$HOME/backups/pulse}"
MANTER_DIAS=30
# Um dump do Pulse com dado real não desce disto. O número é folgado de propósito:
# alto demais recusaria backup legítimo de base pequena, baixo demais aceitaria lixo.
MINIMO_BYTES=20000

if [[ "${1:-}" == "--listar" ]]; then
  ls -lh "$DESTINO" 2>/dev/null || echo "Nenhum backup em $DESTINO"
  exit 0
fi

mkdir -p "$DESTINO"
AGORA=$(date -u '+%Y%m%dT%H%M%SZ')
ALVO="$DESTINO/pulse-$AGORA.sql.gz"
PARCIAL="$ALVO.parcial"

limpar() { rm -f "$PARCIAL"; }
trap limpar EXIT

if ! docker inspect -f '{{.State.Running}}' "$CONTEINER" 2>/dev/null | grep -q true; then
  echo "ERRO: contêiner $CONTEINER não está rodando — nada foi escrito." >&2
  exit 1
fi

# `--clean --if-exists` para o dump poder ser reaplicado sobre uma base existente.
docker exec "$CONTEINER" pg_dump -U postgres --clean --if-exists "$BANCO" \
  | gzip -9 > "$PARCIAL"

TAM=$(stat -c %s "$PARCIAL")
if (( TAM < MINIMO_BYTES )); then
  echo "ERRO: dump com $TAM bytes (mínimo $MINIMO_BYTES) — RECUSADO, o anterior fica." >&2
  exit 1
fi

# Confere que o dump é legível E que as tabelas que mais doem estão nele. Um gzip
# válido de conteúdo errado passaria pelo teste de tamanho.
if ! gzip -t "$PARCIAL" 2>/dev/null; then
  echo "ERRO: gzip corrompido — RECUSADO." >&2
  exit 1
fi
for tabela in ops.kickoff_registro core.account ops.user_role; do
  # `grep -c` e não `grep -q`: com `pipefail`, o `-q` sai no primeiro acerto, o `zcat`
  # leva SIGPIPE e o pipeline devolve erro — o teste recusava o dump BOM. Falhou
  # fechado, que é a direção certa, mas recusava sempre.
  achou=$(zcat "$PARCIAL" | grep -cF "CREATE TABLE $tabela (" || true)
  if [[ "$achou" == "0" ]]; then
    echo "ERRO: $tabela não está no dump — RECUSADO." >&2
    exit 1
  fi
done

# Conta as linhas do kickoff dentro do dump e compara com o banco. Divergência aqui
# significa dump tirado no meio de uma escrita, ou tabela errada.
NO_DUMP=$(zcat "$PARCIAL" | awk '/^COPY ops.kickoff_registro /{f=1;next} f&&/^\\\.$/{f=0} f' | wc -l)
NO_BANCO=$(docker exec "$CONTEINER" psql -U postgres -d "$BANCO" -tAc \
  'SELECT count(*) FROM ops.kickoff_registro' | tr -d ' ')

mv "$PARCIAL" "$ALVO"
trap - EXIT
chmod 600 "$ALVO"

# Rotação só DEPOIS de o novo estar no lugar: apagar antes deixaria a janela em que
# não existe nenhum backup.
find "$DESTINO" -name 'pulse-*.sql.gz' -type f -mtime +$MANTER_DIAS -delete

echo "backup: $ALVO ($(numfmt --to=iec "$TAM"))"
echo "kickoff: $NO_DUMP linha(s) no dump · $NO_BANCO no banco"
if [[ "$NO_DUMP" != "$NO_BANCO" ]]; then
  echo "AVISO: contagem divergente — provável escrita concorrente. O dump ficou, confira." >&2
fi
