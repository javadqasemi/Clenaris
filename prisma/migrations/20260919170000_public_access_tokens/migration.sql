-- Öffentliche Zugriffstokens: eine Infrastruktur statt drei Eigenbauten.
--
-- Rein additiv: ein Aufzählungstyp, eine Tabelle, vier Indizes, ein
-- Fremdschlüssel. Keine bestehende Spalte wird geändert, keine gelöscht.
-- `Quote.publicToken` und `Invoice.publicToken` bleiben vorerst stehen —
-- ohne sie brächen alle bereits versendeten Links sofort, und die Ablösung
-- gehört in einen eigenen, geplanten Rollout.

-- CreateEnum
CREATE TYPE "PublicTokenPurpose" AS ENUM ('QUOTE_VIEW', 'QUOTE_RESPOND', 'INVOICE_VIEW', 'BOOKING_MANAGE', 'DOCUMENT_VIEW', 'SIGNATURE_ACCESS', 'SIGNATURE_OTP');

-- CreateTable
CREATE TABLE "public_access_tokens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "PublicTokenPurpose" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedById" TEXT,
    "lastUsedAt" TIMESTAMPTZ(6),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "actionCompletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "public_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_access_tokens_tokenHash_key" ON "public_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "public_access_tokens_purpose_resourceId_idx" ON "public_access_tokens"("purpose", "resourceId");

-- CreateIndex
CREATE INDEX "public_access_tokens_organizationId_purpose_idx" ON "public_access_tokens"("organizationId", "purpose");

-- CreateIndex
CREATE INDEX "public_access_tokens_expiresAt_idx" ON "public_access_tokens"("expiresAt");

-- AddForeignKey
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
