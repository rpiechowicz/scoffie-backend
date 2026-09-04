---
name: project-docker-no-auto-migrate
description: NIEAKTUALNE od 2026-08-26 — CMD obrazu API odpala teraz migracje przy starcie; ręczny deploy to już tylko no-op-owa asekuracja.
metadata:
  node_type: memory
  type: project
  originSessionId: 07d4f263-e5aa-4641-8925-5354fa37ecd4
  modified: 2026-08-26T13:24:21.003Z
---

**Aktualizacja 2026-08-26:** `scoffie-backend/Dockerfile` kończy się teraz na
`CMD ["sh", "-c", "node scripts/prisma-migrate-deploy-safe.js && exec node dist/main"]`
— kontener sam aplikuje migracje przy każdym starcie. Zweryfikowane w praktyce:
po `docker compose build api && docker compose up -d` migracja `20260826150000_dzienne_kroki`
była już zaaplikowana, a ręczne `pnpm prisma migrate deploy` odpowiedziało
„No pending migrations to apply".

**Jak stosować:** po przebudowie obrazu wystarczy `docker compose up -d`. Ręczny
`docker compose exec api pnpm prisma migrate deploy` można puścić jako asekurację
(jest idempotentny), ale nie jest już wymagany. Stan nadal sprawdzisz przez
`select migration_name from _prisma_migrations`. Historyczny kontekst: wcześniej
CMD nie robiło deployu i pominięta migracja wywalała zakładki błędem
`The table public.X does not exist`. Powiązane: [[project-scoffie-stack]],
[[project-mac-resources-exhausted]].
