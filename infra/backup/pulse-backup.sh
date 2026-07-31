#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Backup do banco do Pulse.
#
# ⚠️ POR QUE ESTE ARQUIVO EXISTE
#
# O backup compartilhado da casa (/opt/stack/infra/backup, timer systemd 03:00
# UTC) roda `pg_dumpall` no Postgres COMPARTILHADO. O Pulse tem instância própria
# (`postgres-pulse`), logo NÃO é coberto por ele. Sem este script, o primeiro BI da
# empresa fica sem backup e ninguém percebe até precisar restaurar.
#
# ⚠️ E O QUE AINDA FALTA
#
# O backup da casa é LOCAL — está documentado que "não cobre perda da VM". Para
# uma base que passa a ser a fonte de NRR e churn da empresa, isso é insuficiente:
# falta destino remoto. Pendência C-13 (doc 02). Este script já grava cifrado
# para que a cópia remota seja só um `rclone`/`oci os object put` a mais.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/stack/backups/pulse}"
RETENCAO_DIAS="${RETENCAO_DIAS:-30}"
CONTAINER="${CONTAINER:-postgres-pulse}"
DB="${DB:-ops}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

# --format=custom permite restauração seletiva de tabela; --no-owner facilita
# restaurar em instância com papéis diferentes (staging).
docker exec "$CONTAINER" pg_dump -U postgres -d "$DB" --format=custom --no-owner \
  > "$BACKUP_DIR/pulse-$STAMP.dump"

if command -v age >/dev/null 2>&1 && [ -n "${AGE_RECIPIENT:-}" ]; then
  age -r "$AGE_RECIPIENT" -o "$BACKUP_DIR/pulse-$STAMP.dump.age" "$BACKUP_DIR/pulse-$STAMP.dump"
  rm -f "$BACKUP_DIR/pulse-$STAMP.dump"
  echo "backup cifrado: $BACKUP_DIR/pulse-$STAMP.dump.age"
else
  # Dump em claro contém dado pessoal. Avisar alto: não é detalhe.
  echo "AVISO: backup NÃO cifrado (defina AGE_RECIPIENT). Contém dado pessoal." >&2
  echo "backup: $BACKUP_DIR/pulse-$STAMP.dump"
fi

find "$BACKUP_DIR" -name 'pulse-*.dump*' -mtime "+$RETENCAO_DIAS" -delete

# A restauração é testada por trimestre (doc 00, 11 · doc 01, 17.4).
# Backup nunca restaurado não é backup — é esperança.
