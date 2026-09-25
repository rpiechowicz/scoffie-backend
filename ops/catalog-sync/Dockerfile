# Nocny eksport katalogu przepisów z bazy do repo — osobny serwis cron
# w projekcie Railway (`catalog-sync`). Opis: DEPLOYMENT.md → „Catalog sync”.
#
# Obraz niesie tylko narzędzia (Node 22 + pnpm z `packageManager` repo, git,
# curl, jq). Kod i zależności pobiera w każdym przebiegu z `develop`
# (`pnpm install --frozen-lockfile`), bo eksport MUSI liczyć tym samym kodem,
# który zaimportuje plik — obraz z własną kopią node_modules rozjechałby się
# z repo przy pierwszej zmianie lockfile'a, a ten serwis przebudowuje się
# tylko po zmianach w `ops/catalog-sync/`.
FROM node:22-bookworm-slim

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends git curl jq ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

# Ta sama wersja co `packageManager` w package.json (i główny Dockerfile).
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

COPY sync.sh /usr/local/bin/scoffie-catalog-sync
RUN chmod 0755 /usr/local/bin/scoffie-catalog-sync

# Jednorazowe zadanie z crona: eksport, ewentualny PR i koniec.
ENTRYPOINT ["/usr/local/bin/scoffie-catalog-sync"]
