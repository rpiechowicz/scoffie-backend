-- Audyt 2 (3.09.2026): po usunięciu konta księga kosztów zostaje bez
-- identyfikatora osoby (RODO art. 17; polityka §12).
ALTER TABLE "AiUsage" ALTER COLUMN "userId" DROP NOT NULL;
