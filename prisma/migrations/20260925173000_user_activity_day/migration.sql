-- Aktywność dzienna osób (ROADMAPA §5.8, §6): jeden wiersz na osobę i dobę
-- warszawską, zapisywany przy pierwszym uwierzytelnionym żądaniu HTTP albo
-- połączeniu socketu (`UserActivityService`). Kaskada z kontem (RODO).

-- CreateTable
CREATE TABLE "UserActivityDay" (
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,

    CONSTRAINT "UserActivityDay_pkey" PRIMARY KEY ("userId","date")
);

-- CreateIndex
CREATE INDEX "UserActivityDay_date_idx" ON "UserActivityDay"("date");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- AddForeignKey
ALTER TABLE "UserActivityDay" ADD CONSTRAINT "UserActivityDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (jednorazowo). HISTORIA AKTYWNOŚCI PRZED TĄ MIGRACJĄ NIE ISTNIEJE:
-- baza pamiętała tylko dwie pewne doby każdej osoby — dzień rejestracji
-- (`createdAt`: konto powstaje przy zalogowaniu, więc osoba była wtedy
-- aktywna) i dzień OSTATNIEGO logowania (`lastLoginAt`). Wszystko pomiędzy
-- przepadło. Panel bierze początek zbierania z daty zastosowania tej migracji
-- (`_prisma_migrations.finished_at`), nie z najstarszego wiersza, i nie
-- pokazuje retencji za tygodnie sprzed niej.
-- Kolumny Prismy trzymają UTC bez strefy, stąd podwójne `AT TIME ZONE`.
INSERT INTO "UserActivityDay" ("userId", "date")
SELECT "id", (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw')::date
  FROM "User"
UNION
SELECT "id", (("lastLoginAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw')::date
  FROM "User"
  WHERE "lastLoginAt" IS NOT NULL
ON CONFLICT DO NOTHING;
