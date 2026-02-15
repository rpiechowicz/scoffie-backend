FROM node:20-bookworm-slim AS deps
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

FROM node:20-bookworm-slim AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV npm_config_registry=$NPM_REGISTRY
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:20-bookworm-slim AS runner
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV npm_config_registry=$NPM_REGISTRY
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/test ./test
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/public ./public
COPY --from=builder /app/nest-cli.json ./nest-cli.json
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY tsconfig.json ./tsconfig.json
COPY tsconfig.build.json ./tsconfig.build.json
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/main"]
