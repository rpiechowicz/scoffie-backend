---
name: project-backend-verify-in-scratch-container
description: 'Backend weryfikuje się w jednorazowym kontenerze z obrazu API — lokalny prisma generate/tsc/jest się wieszają, a bind-mount źródeł wywala EIO.'
metadata:
  node_type: memory
  type: project
  originSessionId: b2c1c8be-870b-42da-a493-b2dd70f946b0
  modified: 2026-08-23T08:12:19.581Z
---

Sprawdzony sposób na `prisma generate` + `tsc` + `jest` w `scoffie-backend`, gdy
lokalnie się wieszają (2026-08-23, działa):

```
CID=$(docker create scoffie-backend-api sleep 7200) && docker start $CID
docker cp ./src "$CID:/app/"; docker cp ./prisma "$CID:/app/"
docker cp ./scripts "$CID:/app/"; docker cp ./test "$CID:/app/"
docker cp ./jest.config.js "$CID:/app/"
docker exec $CID sh -c "cd /app && npx prisma generate && npx tsc --noEmit -p tsconfig.build.json"
docker exec -e NODE_OPTIONS=--experimental-vm-modules $CID sh -c "cd /app && npx jest --ci"
docker rm -f $CID
```

**Dlaczego akurat tak:**

- `docker cp`, a NIE `-v $PWD/src:/app/src` — bind-mount źródeł do tego obrazu wywala
  `Error: EIO: i/o error, read` przy `prisma generate`.
- Jednorazowy kontener, a nie `docker compose exec api` — działające API ma źródła
  wypieczone w obrazie (bez bind-mountu), więc i tak nie widzi zmian, a regenerowanie
  klienta pod nim rusza jego `node_modules`.
- `tsconfig.build.json`, nie `tsconfig.json` — to drugie ma `include: test/**/*.ts` przy
  `rootDir: src`, więc sypie TS6059 niezależnie od Twoich zmian.
- `NODE_OPTIONS=--experimental-vm-modules` — bez tego 3 testy `apple-identity.service.spec`
  wywalają się na dynamicznym imporcie. Skrypt `pnpm test` dokłada tę flagę sam.
- `jest.config.js` trzeba skopiować osobno: obraz jest produkcyjny i go nie ma, a bez niego
  jest bierze babel i nie parsuje TypeScriptu.

Migrację SQL da się wypróbować na prawdziwych danych bez zapisu:
`{ echo BEGIN; cat migration.sql; echo ROLLBACK; } | docker compose exec -T db psql -U scoffie -d scoffie -v ON_ERROR_STOP=1`

Powiązane: [[project-stale-local-prisma-client]], [[project-mac-resources-exhausted]],
[[project-docker-no-auto-migrate]].
