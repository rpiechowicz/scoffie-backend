-- CreateTable
CREATE TABLE "FxRate" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "pair" TEXT NOT NULL,
    "rate" DECIMAL(14,8) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppleSalesDay" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "proceeds" DECIMAL(14,4) NOT NULL,
    "proceedsCurrency" TEXT NOT NULL,
    "customerPrice" DECIMAL(14,4) NOT NULL,
    "customerCurrency" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppleSalesDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppleFinanceMonth" (
    "month" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "proceeds" DECIMAL(14,4) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppleFinanceMonth_pkey" PRIMARY KEY ("month","currency")
);

-- CreateTable
CREATE TABLE "AppleReportSync" (
    "kind" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "AppleReportSync_pkey" PRIMARY KEY ("kind")
);

-- CreateIndex
CREATE INDEX "FxRate_pair_date_idx" ON "FxRate"("pair", "date");

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_date_pair_key" ON "FxRate"("date", "pair");

-- CreateIndex
CREATE INDEX "AppleSalesDay_date_idx" ON "AppleSalesDay"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AppleSalesDay_date_sku_country_productType_proceedsCurrency_key" ON "AppleSalesDay"("date", "sku", "country", "productType", "proceedsCurrency", "customerCurrency");
