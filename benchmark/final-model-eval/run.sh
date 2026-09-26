#!/usr/bin/env bash
# Etap 6 — sekwencyjny, przeplatany benchmark (concurrency 1) z twardym budżetem.
#
# Użycie:
#   run.sh pair  <runs> <scen1,scen2,...>        # anchor i HEAD na przemian, config A
#   run.sh cand  <config> <runs> <scen1,...>      # kandydat na HEAD
#
# Wymaga: ANCHOR_DIR (worktree 22aa63c z tym samym harnessem), klucz w .env,
# lokalny Postgres z katalogiem. Każdy scenariusz = osobny proces (cache
# promptu po stronie dostawcy przeżywa restart procesu).
set -u
HEAD_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$HEAD_DIR/benchmark/final-model-eval"
CAP_USD="${CAP_USD:-40}"
PER_CALL_CAP="${PER_CALL_CAP:-1.5}"
export DATABASE_URL='postgresql://scoffie:scoffie@localhost:5432/scoffie?schema=public'
export TS_NODE_TRANSPILE_ONLY=true
ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' "$HEAD_DIR/.env" | cut -d= -f2- | tr -d '"')"
export ANTHROPIC_API_KEY

spent() {
  node -e '
    const fs=require("fs"),p=require("path");
    let t=0;const walk=d=>{for(const f of fs.readdirSync(d)){const q=p.join(d,f);
      if(fs.statSync(q).isDirectory())walk(q);else if(f.endsWith(".json")&&f!=="freeze.json"&&f!=="summary.json"){
        try{const j=JSON.parse(fs.readFileSync(q,"utf8"));t+=(j.budget?.spentUsd)||0}catch{}}}};
    walk(process.argv[1]);console.log(t.toFixed(4));' "$OUT"
}

guard() {
  local s; s="$(spent)"
  if node -e "process.exit(Number('$s') >= Number('$CAP_USD') ? 0 : 1)"; then
    echo "STOP: wydane $s USD >= limit $CAP_USD USD"; exit 3
  fi
  echo "   (łącznie wydane: $s USD)"
}

one() { # dir label config runs scenario outfile
  (cd "$1" && pnpm -s agent:scenarios -- --only "$5" --config "$3" --runs "$4" \
    --cards strict --concurrency 1 --max-cost-usd "$PER_CALL_CAP" \
    --label "$2" --out "$6" 2>&1 | grep -E '^\[|Wyniki:|STOP|Error|nie powiodły' )
}

mode="$1"; shift
if [ "$mode" = pair ]; then
  runs="$1"; list="$2"; tag="${3:-r1}"
  for s in ${list//,/ }; do
    guard
    echo "== $s  BEFORE (22aa63c)"
    one "$ANCHOR_DIR" "before-$s" A "$runs" "$s" "$OUT/before/$s.$tag.json"
    guard
    echo "== $s  AFTER (HEAD)"
    one "$HEAD_DIR" "after-$s" A "$runs" "$s" "$OUT/after/$s.$tag.json"
  done
elif [ "$mode" = cand ]; then
  cfg="$1"; runs="$2"; list="$3"; tag="${4:-r1}"
  mkdir -p "$OUT/candidates/$cfg"
  for s in ${list//,/ }; do
    guard
    echo "== $s  kandydat $cfg"
    one "$HEAD_DIR" "cand-$cfg-$s" "$cfg" "$runs" "$s" "$OUT/candidates/$cfg/$s.$tag.json"
  done
fi
guard
