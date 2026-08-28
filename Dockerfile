# Node 22 we wszystkich etapach — to samo, co CI (`backend-ci.yml`) i README.
# Node 20 skończył wsparcie 30.04.2026, a prod chodził na nim, choć testy
# biegły na 22.
FROM node:22-bookworm-slim AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV npm_config_registry=$NPM_REGISTRY
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
RUN pnpm prisma generate

FROM node:22-bookworm-slim AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV npm_config_registry=$NPM_REGISTRY
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runner
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV npm_config_registry=$NPM_REGISTRY
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
# Cache corepacka poza HOME roota: `corepack prepare` biegnie jako root, a
# proces chodzi jako `node`. Bez wspólnego COREPACK_HOME użytkownik `node`
# widział pusty cache i corepack ŚCIĄGAŁ najnowszego pnpm przy każdym
# starcie kontenera (pnpm 11 próbował wtedy przeinstalować node_modules
# i padał bez TTY). Po przygotowaniu sieć dla corepacka wyłączona: brak
# pinu ma się skończyć głośnym błędem, nie cichym pobraniem.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate \
  && chown -R node:node /opt/corepack
ENV COREPACK_ENABLE_NETWORK=0
# Pełne `node_modules` (z devDependencies) świadomie: CMD odpala `prisma
# migrate deploy` i skrypty `tsx`, a oba pakiety są w devDependencies.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# `src` zostaje: skrypty `tsx` importują `../src/…` (normalizator, klasyfikator).
# `test` już nie — jest nie biega w obrazie.
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/public ./public
COPY --from=builder /app/nest-cli.json ./nest-cli.json
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY tsconfig.json ./tsconfig.json
COPY tsconfig.build.json ./tsconfig.build.json
COPY package.json ./
# Proces nie ma prawa chodzić jako root: obraz ma na pokładzie źródła
# i skrypty, a niedługo warstwę narzędzi agenta — każdy błąd tam ma mieć
# blast radius użytkownika bez uprawnień.
RUN chown -R node:node /app
USER node
EXPOSE 3000
# Sonda żywotności dla platformy: `/ops/health` nie dotyka bazy, więc mówi
# tylko „proces odpowiada". `start-period` obejmuje migracje z CMD.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ops/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migracje przed startem, a nie „pamiętaj puścić je ręcznie".
#
# Obraz startował dotąd samym `node dist/main`, przez co przebudowa API
# potrafiła podnieść kod, który pyta o kolumnę nieistniejącą jeszcze w bazie.
# `prisma-migrate-deploy-safe.js` jest idempotentny, więc restart kontenera
# bez nowych migracji nic nie kosztuje.
#
# `exec` na końcu jest istotny: bez niego `node` zostaje dzieckiem `sh`
# i nie dostaje SIGTERM przy zatrzymywaniu kontenera, czyli nie ma jak
# zamknąć się czysto.
CMD ["sh", "-c", "node scripts/prisma-migrate-deploy-safe.js && exec node dist/main"]
