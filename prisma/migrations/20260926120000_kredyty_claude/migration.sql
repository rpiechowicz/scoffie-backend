-- CreateTable
CREATE TABLE "AnthropicCreditAnchor" (
    "id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "balanceUsd" DECIMAL(12,2) NOT NULL,
    "amountUsd" DECIMAL(12,2),
    "note" TEXT,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "AnthropicCreditAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnthropicBillingSetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lowBalanceUsd" DECIMAL(12,2) NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AnthropicBillingSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnthropicCreditAnchor_at_idx" ON "AnthropicCreditAnchor"("at");
