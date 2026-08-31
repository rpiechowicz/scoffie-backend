import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // Prisma ≥ 6.16: `seed` siedzi pod `migrations` (top-level był ignorowany;
  // `pnpm prisma:seed` i tak woła tsx bezpośrednio).
  migrations: { seed: 'tsx prisma/seed.ts' },
});
