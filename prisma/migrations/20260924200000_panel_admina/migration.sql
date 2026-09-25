-- Panel administratora (docs/plans/scoffie-admin/ROADMAPA.md §4, §5.5, §6).
--
-- Migracja WYŁĄCZNIE addytywna: nowe tabele panelu (osobna tożsamość admina,
-- passkeye, TOTP, kody odzyskiwania, sesje, próby logowania, dziennik audytu,
-- wyzwania WebAuthn) i trzy kolumny statusu na "AgentReport". Żadna istniejąca
-- kolumna nie zmienia typu ani nie znika, więc poprzednia wersja aplikacji
-- działa na tej bazie bez zmian (rollback bez migracji w dół).
--
-- Tabele panelu nie mają kluczy obcych do tabel aplikacji — w obie strony:
-- `AgentReport.reviewedByAdminId` to goły UUID. `ADD COLUMN ... DEFAULT 'NEW'`
-- ze stałą wartością domyślną to w Postgresie zmiana samych metadanych
-- (bez przepisywania tabeli).

-- AlterTable
ALTER TABLE "AgentReport" ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByAdminId" UUID,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'NEW';

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "webauthnUserId" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminCredential" (
    "id" UUID NOT NULL,
    "adminUserId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AdminCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminTotp" (
    "adminUserId" UUID NOT NULL,
    "secretEncrypted" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "lastUsedStep" INTEGER,
    "pendingSecretEncrypted" TEXT,
    "pendingCreatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminTotp_pkey" PRIMARY KEY ("adminUserId")
);

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" UUID NOT NULL,
    "adminUserId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" UUID NOT NULL,
    "adminUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "mustReenroll" BOOLEAN NOT NULL DEFAULT false,
    "stepUpUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "ip" TEXT,
    "country" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminLoginAttempt" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "adminUserId" UUID,
    "ip" TEXT,
    "country" TEXT,
    "userAgent" TEXT,
    "method" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" UUID NOT NULL,
    "adminUserId" UUID,
    "adminEmail" TEXT NOT NULL,
    "sessionId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "reason" TEXT,
    "details" JSONB,
    "result" TEXT NOT NULL,
    "errorCode" TEXT,
    "ip" TEXT,
    "country" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminWebAuthnChallenge" (
    "id" UUID NOT NULL,
    "challenge" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "adminUserId" UUID,
    "sessionId" UUID,
    "webauthnUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminWebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_webauthnUserId_key" ON "AdminUser"("webauthnUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminCredential_credentialId_key" ON "AdminCredential"("credentialId");

-- CreateIndex
CREATE INDEX "AdminCredential_adminUserId_idx" ON "AdminCredential"("adminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_adminUserId_idx" ON "AdminRecoveryCode"("adminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_createdAt_idx" ON "AdminSession"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AdminLoginAttempt_email_createdAt_idx" ON "AdminLoginAttempt"("email", "createdAt");

-- CreateIndex
CREATE INDEX "AdminLoginAttempt_ip_createdAt_idx" ON "AdminLoginAttempt"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminUserId_createdAt_idx" ON "AdminAuditLog"("adminUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminWebAuthnChallenge_challenge_key" ON "AdminWebAuthnChallenge"("challenge");

-- CreateIndex
CREATE INDEX "AdminWebAuthnChallenge_expiresAt_idx" ON "AdminWebAuthnChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentReport_status_createdAt_idx" ON "AgentReport"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminCredential" ADD CONSTRAINT "AdminCredential_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminTotp" ADD CONSTRAINT "AdminTotp_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
