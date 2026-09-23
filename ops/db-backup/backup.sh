#!/bin/bash
# Nocna kopia bazy produkcyjnej do Cloudflare R2 — serwis cron `db-backup`
# w projekcie Railway `scoffie`. Opis, zmienne i odtwarzanie: DEPLOYMENT.md
# → „Backups".
#
# Dlaczego tu, a nie w GitHub Actions: po audycie 12.09.2026 Postgres stracił
# publiczny proxy TCP (słusznie), a workflow w Actions łączył się właśnie przez
# niego — od tego dnia każda nocna kopia padała na `pg_dump`. Wewnątrz
# Railwaya baza jest osiągalna siecią prywatną (`postgres.railway.internal`),
# więc nic nie musi wystawać do internetu.
#
# Kolejność: zrzut → spis treści → PRAWDZIWE odtworzenie do tymczasowego
# klastra i policzenie kont → szyfrowanie age → R2 → sprzątanie starych.
# Kopia, której nikt nie odtworzył, jest tylko nadzieją; niezaszyfrowany
# zrzut (alergeny — art. 9 RODO) nie wychodzi nigdzie.
set -Eeuo pipefail

RETENTION_DAYS="${RETENTION_DAYS:-30}"
PREFIX="${PREFIX:-scoffie}"
STEP="start"

log() { echo "[db-backup] $*"; }

alert() {
  # Polskie cudzysłowy w treści są celowe — to tekst alertu, nie składnia.
  # shellcheck disable=SC1111
  local msg="Scoffie: nocna kopia bazy NIE powiodła się na kroku „${STEP}” (Railway, serwis db-backup). Logi: Railway → db-backup → Deployments."
  echo "[db-backup] BŁĄD: $msg" >&2
  if [ -n "${OPS_ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
      -d "$(printf '{"content":"%s","text":"%s"}' "$msg" "$msg")" \
      "$OPS_ALERT_WEBHOOK_URL" >/dev/null || echo "[db-backup] alert też nie wyszedł" >&2
  fi
}

WORK="$(mktemp -d /tmp/db-backup.XXXXXX)"
PGDATA_TMP="$WORK/pgdata"
SOCK="$WORK/sock"

cleanup() {
  local status=$?
  if [ -f "$PGDATA_TMP/postmaster.pid" ]; then
    gosu postgres pg_ctl -D "$PGDATA_TMP" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  if [ "$status" -ne 0 ]; then alert; fi
  exit "$status"
}
trap cleanup EXIT

STEP="zmienne"
for v in DATABASE_URL R2_BACKUP_ENDPOINT R2_BACKUP_BUCKET R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY BACKUP_AGE_PUBLIC_KEY; do
  if [ -z "${!v:-}" ]; then log "brak zmiennej $v"; exit 1; fi
done
case "$BACKUP_AGE_PUBLIC_KEY" in
  age1*) ;;
  *) log "BACKUP_AGE_PUBLIC_KEY nie wygląda na klucz publiczny age (age1…)"; exit 1 ;;
esac

STEP="pg_dump"
stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
FILE="$WORK/${PREFIX}-${stamp}.dump"
# Format custom: skompresowany, odtwarzalny wybiórczo przez pg_restore.
pg_dump --format=custom --no-owner --no-privileges --file "$FILE" "$DATABASE_URL"
size=$(stat -c %s "$FILE")
# Pusta albo śladowa kopia to porażka, nie sukces.
if [ "$size" -lt 20000 ]; then log "zrzut ma tylko $size B"; exit 1; fi
log "zrzut: $(basename "$FILE") ($size B)"

STEP="spis treści"
pg_restore --list "$FILE" > "$WORK/toc.txt"
ENTRIES=$(grep -c -v '^;' "$WORK/toc.txt" || true)
if [ "$ENTRIES" -lt 50 ]; then log "spis treści ma tylko $ENTRIES wpisów — to nie jest pełna baza"; exit 1; fi
log "spis treści: $ENTRIES wpisów"

STEP="próba odtworzenia"
# Tymczasowy klaster tylko na gnieździe unixowym — bez TCP, żyje do końca
# przebiegu. initdb nie działa jako root, stąd gosu (jest w obrazie).
chmod 0711 "$WORK"
install -d -o postgres -g postgres -m 0700 "$PGDATA_TMP"
install -d -o postgres -g postgres -m 0755 "$SOCK"
gosu postgres initdb -D "$PGDATA_TMP" -U restore --auth=trust >/dev/null
gosu postgres pg_ctl -D "$PGDATA_TMP" -w -l "$WORK/pg.log" \
  -o "-c listen_addresses='' -k $SOCK" start >/dev/null
CHECK_URL="postgresql:///postgres?host=$SOCK&user=restore"
psql "$CHECK_URL" -qAtc 'create database restorecheck' >/dev/null
CHECK_URL="postgresql:///restorecheck?host=$SOCK&user=restore"
# Bez --exit-on-error: pg_restore zgłasza nieszkodliwe błędy (np. komentarz do
# schematu public bez właściciela). O kompletności decydują liczby niżej.
pg_restore --no-owner --no-privileges -d "$CHECK_URL" "$FILE" 2> "$WORK/restore.log" || true
ERRORS=$(grep -c 'pg_restore: error' "$WORK/restore.log" || true)
if [ "$ERRORS" -gt 0 ]; then
  log "błędy pg_restore ($ERRORS):"
  grep 'pg_restore: error' "$WORK/restore.log" | head -n 10
fi
if [ "$ERRORS" -gt 3 ]; then log "odtworzenie zgłosiło $ERRORS błędów — to nie jest odtwarzalna kopia"; exit 1; fi
TABLES=$(psql "$CHECK_URL" -Atc "select count(*) from information_schema.tables where table_schema='public'")
USERS=$(psql "$CHECK_URL" -Atc 'select count(*) from "User"')
RECIPES=$(psql "$CHECK_URL" -Atc 'select count(*) from "Recipe"')
log "odtworzono: tabel=$TABLES kont=$USERS przepisów=$RECIPES"
if [ "$TABLES" -lt 20 ] || [ "$USERS" -lt 1 ]; then
  log "odtworzona baza jest niekompletna (tabel=$TABLES, kont=$USERS)"; exit 1
fi
gosu postgres pg_ctl -D "$PGDATA_TMP" -m fast stop >/dev/null

STEP="szyfrowanie"
age -r "$BACKUP_AGE_PUBLIC_KEY" -o "$FILE.age" "$FILE"
rm -f "$FILE"
FILE="$FILE.age"
NAME="$(basename "$FILE")"

STEP="wysyłka do R2"
export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true
S3="s3://$R2_BACKUP_BUCKET/$PREFIX"
aws s3 cp "$FILE" "$S3/$NAME" --endpoint-url "$R2_BACKUP_ENDPOINT" --only-show-errors
aws s3 ls "$S3/$NAME" --endpoint-url "$R2_BACKUP_ENDPOINT" >/dev/null
log "w R2: $S3/$NAME ($(stat -c %s "$FILE") B)"

STEP="sprzątanie starych kopii"
cutoff=$(date -u -d "-${RETENTION_DAYS} days" +%Y-%m-%dT%H%M%SZ)
aws s3 ls "$S3/" --endpoint-url "$R2_BACKUP_ENDPOINT" \
  | awk '{print $4}' | { grep -E "^${PREFIX}-.*[.]dump([.]age)?\$" || true; } \
  | while read -r name; do
      old="${name#"${PREFIX}"-}"; old="${old%.age}"; old="${old%.dump}"
      if [[ "$old" < "$cutoff" ]]; then
        log "usuwam $name (starsze niż $RETENTION_DAYS dni)"
        aws s3 rm "$S3/$name" --endpoint-url "$R2_BACKUP_ENDPOINT" --only-show-errors
      fi
    done

STEP="koniec"
log "OK — kopia $NAME gotowa i sprawdzona odtworzeniem"
