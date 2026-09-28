#!/bin/sh
# Lokalny Docker: wgrywa do bazy dev aktualny katalog z repo (składniki, makro,
# tagi, przepisy ze zdjęciami). Potrzebne, gdy baza ma już stary katalog —
# `docker compose up` wczytuje go sam TYLKO do pustej bazy.
#
#   sh scripts/local-catalog-sync.sh
#
# Nadpisuje przepisy katalogu w LOKALNEJ bazie wersją z pliku (potwierdzenie
# dzisiejszą datą). Na prod NIE używać — tam runbook
# `docs/runbooks/katalog-1000-wdrozenie.md` ze sprawdzeniem edycji z panelu.
set -e
cd "$(dirname "$0")/.."

docker compose up -d --build api
docker compose exec -T api pnpm catalog:ingredients:load
docker compose exec -T api pnpm catalog:ingredients:nutrition
docker compose exec -T api pnpm catalog:ingredients:tags
docker compose exec -T \
  -e RECIPE_IMPORT_FILE=prisma/catalog/recipes-catalog-full-v2.json \
  -e RECIPE_IMPORT_FROM_JSON_CONFIRM="$(date +%F)" \
  api pnpm recipes:import:json

echo
echo "Katalog wgrany. W symulatorze uruchom aplikację ponownie — pobierze go od nowa."
