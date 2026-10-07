-- Darmowa pula asystenta wraca co AI_TRIAL_RENEW_DAYS (30) dni od pierwszego
-- użycia osoby. Kotwica cyklu leży na zakresie puli próbnej.
CREATE TABLE "AiFreeQuotaCycle" (
    "scopeId" TEXT NOT NULL,
    "anchoredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiFreeQuotaCycle_pkey" PRIMARY KEY ("scopeId")
);

-- Kto już używał jednorazowej próby, dostaje świeżą pulę OD RAZU (decyzja
-- Rafała 7.10.2026): kotwica 30 dni wstecz = dziś zaczyna się drugi cykl.
-- Kolejne odnowienie — za 30 dni od wdrożenia.
INSERT INTO "AiFreeQuotaCycle" ("scopeId", "anchoredAt")
SELECT DISTINCT "scopeId", CURRENT_TIMESTAMP - INTERVAL '30 days'
FROM "AiUsageCounter"
WHERE "periodKey" = 'trial' AND "scopeId" LIKE 'trial:%'
ON CONFLICT DO NOTHING;
