#!/bin/bash
# Nocny eksport katalogu przepisów z bazy do repo — serwis cron `catalog-sync`
# w projekcie Railway `scoffie`. Opis i zmienne: DEPLOYMENT.md → „Catalog sync”.
#
# Decyzja D1 (25.09.2026): źródłem prawdy katalogu jest baza (panel admina
# zapisuje od razu), a `prisma/catalog/recipes-catalog-full-v2.json` jej
# wiernym odbiciem w repo. Ten skrypt: klon `develop` → `pnpm catalog:export`
# siecią prywatną Railwaya → przy różnicy commit bota i PR do `develop`
# (otwarty PR bota = aktualizacja JEGO gałęzi, nie drugi PR). Brak różnic =
# nic. Baza jest tylko CZYTANA.
#
# Token GitHuba nie trafia ani do logów, ani do argumentów procesów: git
# dostaje nagłówek przez GIT_CONFIG_* w środowisku, curl — przez `--config -`
# ze stdin. Nigdy `set -x`.
set -Eeuo pipefail
# Jeden strumień i pierwsza linia przed czymkolwiek, co może się nie udać —
# brak tej linii w logach = skrypt w ogóle nie ruszył (lekcja z db-backup).
exec 2>&1
echo "[catalog-sync] start $(date -u +%FT%TZ) — node $(node --version 2>/dev/null || echo '?'), git $(git --version 2>/dev/null | awk '{print $3}'), dry_run=${CATALOG_SYNC_DRY_RUN:-false}, repo=${GITHUB_REPO:-rpiechowicz/scoffie-backend}@${CATALOG_SYNC_BASE_BRANCH:-develop}"

DRY_RUN="${CATALOG_SYNC_DRY_RUN:-false}"
REPO="${GITHUB_REPO:-rpiechowicz/scoffie-backend}"
BASE="${CATALOG_SYNC_BASE_BRANCH:-develop}"
# Tylko do sprawdzenia lokalnego: klon z zamontowanego repo zamiast z GitHuba.
LOCAL_REPO="${CATALOG_SYNC_LOCAL_REPO:-}"
CATALOG_FILE="prisma/catalog/recipes-catalog-full-v2.json"
BRANCH_PREFIX="chore/katalog-z-bazy-"
TODAY="$(date -u +%Y-%m-%d)"
API="https://api.github.com/repos/$REPO"
STEP="start"

log() { echo "[catalog-sync] $*"; }

alert() {
  # Polskie cudzysłowy w treści są celowe — to tekst alertu, nie składnia.
  # shellcheck disable=SC1111
  local msg="Scoffie: nocny eksport katalogu NIE powiódł się na kroku „${STEP}” (Railway, serwis catalog-sync). Logi: Railway → catalog-sync → Deployments."
  echo "[catalog-sync] BŁĄD: $msg"
  if [ -n "${OPS_ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
      -d "$(jq -n --arg m "$msg" '{content: $m, text: $m}')" \
      "$OPS_ALERT_WEBHOOK_URL" >/dev/null || echo "[catalog-sync] alert też nie wyszedł"
  fi
}

WORK="$(mktemp -d /tmp/catalog-sync.XXXXXX)"
cleanup() {
  local status=$?
  rm -rf "$WORK"
  if [ "$status" -ne 0 ]; then alert; fi
  exit "$status"
}
trap cleanup EXIT

# Zapytanie do API GitHuba: token idzie w konfiguracji curla ze stdin, więc
# nie widać go w `ps` ani w logu. Zwraca ciało odpowiedzi; błąd HTTP = exit ≠ 0.
github() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-fsS -m 30 -X "$method" -H 'Accept: application/vnd.github+json'
    -H 'X-GitHub-Api-Version: 2022-11-28' "$API$path")
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' -d "$body"); fi
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" |
    curl --config - "${args[@]}"
}

# Nagłówek autoryzacji dla gita w środowisku (GIT_CONFIG_*), nie w URL-u
# i nie w argumentach — `git remote -v` i log pokazują czysty adres.
use_git_token() {
  local basic
  basic="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
  export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic"
}

STEP="zmienne"
REQUIRED="DATABASE_URL"
if [ "$DRY_RUN" != "true" ]; then REQUIRED="$REQUIRED GITHUB_TOKEN"; fi
for v in $REQUIRED; do
  if [ -z "${!v:-}" ]; then log "brak zmiennej $v"; exit 1; fi
done
HAS_TOKEN=false
if [ -n "${GITHUB_TOKEN:-}" ]; then HAS_TOKEN=true; use_git_token; fi

STEP="klon repo"
if [ -n "$LOCAL_REPO" ]; then
  # Zamontowany katalog ma innego właściciela niż root w kontenerze — bez tego
  # git odmawia („dubious ownership”). `file://`, bo przy gołej ścieżce git
  # ignoruje `--depth`.
  git config --global --add safe.directory '*'
  SOURCE="file://$LOCAL_REPO"
else
  SOURCE="https://github.com/$REPO.git"
fi
git clone -q --depth 1 --branch "$BASE" "$SOURCE" "$WORK/repo"
cd "$WORK/repo"
log "klon $BASE @ $(git rev-parse --short HEAD)"

STEP="pnpm install"
# Zależności z lockfile'a TEJ rewizji: eksport liczy się kodem z develop,
# więc obraz nie może mieć własnej, rozjeżdżającej się kopii node_modules.
export PNPM_HOME="$WORK/pnpm" npm_config_store_dir="$WORK/pnpm-store"
export CI=true HUSKY=0
started=$(date +%s)
pnpm install --frozen-lockfile --loglevel=warn
pnpm exec prisma generate >/dev/null
log "zależności: $(( $(date +%s) - started )) s"

STEP="eksport"
# Plik podsumowania powstaje tylko przy różnicy: 1. linia = liczby, potem tytuły.
pnpm exec tsx scripts/export-catalog.ts --summary "$WORK/summary.txt"

if git diff --quiet -- "$CATALOG_FILE"; then
  STEP="koniec"
  log "OK — plik katalogu zgodny z bazą, nic do zrobienia"
  exit 0
fi
COUNTS="$(head -n 1 "$WORK/summary.txt" 2>/dev/null || echo 'zmiana układu pliku')"
log "różnica wobec $BASE: $COUNTS ($(git diff --numstat -- "$CATALOG_FILE" | awk '{print "+"$1" −"$2}') linii)"

STEP="otwarty PR bota"
OPEN_PR=""
OPEN_BRANCH=""
if [ "$HAS_TOKEN" = "true" ]; then
  owner="${REPO%%/*}"
  pulls="$(github GET "/pulls?state=open&base=$BASE&per_page=100")"
  # Błąd jq (np. nieoczekiwana odpowiedź API) przerywa przebieg — ciche „brak
  # PR-a” skończyłoby się drugim, zdublowanym PR-em.
  found="$(jq -r --arg p "$BRANCH_PREFIX" --arg o "$owner" \
    '[.[] | select(.head.ref | startswith($p))
          | select((.head.repo.full_name // "") | startswith($o + "/"))]
     | sort_by(.number) | last
     | if . == null then "" else "\(.number) \(.head.ref)" end' <<<"$pulls")"
  read -r OPEN_PR OPEN_BRANCH <<<"$found" || true
elif [ -n "${CATALOG_SYNC_DRY_RUN_OPEN_PR:-}" ]; then
  # Tylko suchy przebieg bez tokenu: udawany otwarty PR „<numer> <gałąź>”.
  read -r OPEN_PR OPEN_BRANCH <<<"$CATALOG_SYNC_DRY_RUN_OPEN_PR"
fi
if [ -n "$OPEN_PR" ]; then
  TARGET="$OPEN_BRANCH"
  log "otwarty PR bota #$OPEN_PR ($TARGET) — zaktualizuję jego gałąź"
else
  TARGET="$BRANCH_PREFIX$TODAY"
  log "brak otwartego PR-a bota — nowa gałąź $TARGET i PR do $BASE"
fi

TITLE="chore(katalog): eksport z bazy $TODAY ($COUNTS)"
# Odwrócone apostrofy w treści PR-a to Markdown, nie podstawienie polecenia.
# shellcheck disable=SC2016
BODY="$(printf 'Nocny eksport katalogu przepisów z bazy produkcyjnej (serwis Railway `catalog-sync`, decyzja D1: baza = źródło prawdy, plik = jej odbicie).\n\n%s\n\nPlik wygenerowany przez `pnpm catalog:export` — nie poprawiaj go ręcznie; zmiany przepisów rób w panelu admina.' "$(cat "$WORK/summary.txt" 2>/dev/null || echo "$COUNTS")")"

STEP="commit"
git checkout -q -b "$TARGET"
git -c user.name="Scoffie Catalog Bot" -c user.email="catalog-bot@scoffie.app" \
  commit -q -m "$TITLE" -m "$(cat "$WORK/summary.txt" 2>/dev/null || echo "$COUNTS")" -- "$CATALOG_FILE"
log "commit $(git rev-parse --short HEAD): $TITLE"

if [ "$DRY_RUN" = "true" ]; then
  STEP="koniec"
  if [ -n "$OPEN_PR" ]; then
    log "SUCHY PRZEBIEG — zrobiłbym: push --force na $TARGET i PATCH tytułu/opisu PR #$OPEN_PR"
  else
    log "SUCHY PRZEBIEG — zrobiłbym: push $TARGET i POST PR „$TITLE” → $BASE"
  fi
  if [ "$HAS_TOKEN" != "true" ]; then
    log "(bez GITHUB_TOKEN nie sprawdzałem otwartych PR-ów na GitHubie)"
  fi
  log "podsumowanie:"
  sed 's/^/[catalog-sync]   /' "$WORK/summary.txt" 2>/dev/null || true
  exit 0
fi

STEP="push"
# Gałąź bota zawiera zawsze JEDEN commit na świeżym develop: PR pokazuje
# dokładnie bieżącą różnicę baza ↔ develop, więc nadpisanie jest bezpieczne.
git push -q --force origin "HEAD:refs/heads/$TARGET"
log "wypchnięte na $TARGET"

STEP="PR"
if [ -n "$OPEN_PR" ]; then
  github PATCH "/pulls/$OPEN_PR" "$(jq -n --arg t "$TITLE" --arg b "$BODY" '{title: $t, body: $b}')" >/dev/null
  log "OK — zaktualizowany PR #$OPEN_PR"
else
  url="$(github POST "/pulls" "$(jq -n --arg t "$TITLE" --arg b "$BODY" --arg h "$TARGET" --arg base "$BASE" \
    '{title: $t, body: $b, head: $h, base: $base}')" | jq -r '.html_url')"
  log "OK — nowy PR: $url"
fi
STEP="koniec"
