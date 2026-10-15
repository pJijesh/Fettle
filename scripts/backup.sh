#!/usr/bin/env bash
# Takes a compressed, consistent backup of the Fettle database.
#
#   DATABASE_OWNER_URL=postgres://owner@host/db BACKUP_DIR=/var/backups/fettle scripts/backup.sh
#
# Optional:
#   BACKUP_PASSPHRASE   encrypts the file with AES-256 (openssl). Keep the passphrase somewhere other than the backups.
#   BACKUP_KEEP_DAYS    delete backups older than this many days (default 30; 0 keeps everything)
#
# The file is written under a temporary name and renamed only when complete, so a half-written backup is never
# mistaken for a good one. A SHA-256 file is written next to it.
set -euo pipefail

: "${DATABASE_OWNER_URL:?Set DATABASE_OWNER_URL to the owner connection string}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$BACKUP_DIR/fettle-$stamp.dump"
tmp="$base.partial"
trap 'rm -f "$tmp"' EXIT

pg_dump --format=custom --compress=6 --no-owner --serializable-deferrable --dbname="$DATABASE_OWNER_URL" --file="$tmp"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -in "$tmp" -out "$tmp.enc"
  rm -f "$tmp"
  tmp="$tmp.enc"
  base="$base.enc"
fi

mv "$tmp" "$base"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$base")" > "$(basename "$base").sha256" )
chmod 600 "$base" "$base.sha256"

if [ "$KEEP_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'fettle-*.dump*' -mtime "+$KEEP_DAYS" -delete
fi

echo "$base"
