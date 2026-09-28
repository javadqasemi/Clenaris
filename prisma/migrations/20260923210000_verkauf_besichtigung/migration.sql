-- Wave 12 (2026-09-23): Besichtigung / Objektaufnahme als Grundlage der Offerte.
--
-- Von Hand ergänzt (am Ende): CHECK-Bedingungen, die das Schema nicht
-- ausdrücken kann.

-- CreateEnum
CREATE TYPE "SiteVisitStatus" AS ENUM ('PLANNED', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "site_visits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "SiteVisitStatus" NOT NULL DEFAULT 'PLANNED',
    "leadId" TEXT,
    "customerId" TEXT,
    "propertyId" TEXT,
    "scheduledAt" TIMESTAMPTZ(6) NOT NULL,
    "performedAt" TIMESTAMPTZ(6),
    "assessorId" TEXT,
    "propertyKind" "PropertyKind" NOT NULL DEFAULT 'OFFICE',
    "street" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "hasPets" BOOLEAN NOT NULL DEFAULT false,
    "accessNotes" TEXT,
    "findings" TEXT,
    "calculation" JSONB,
    "calculatedAt" TIMESTAMPTZ(6),
    "quoteId" TEXT,
    "cancelledReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_visit_areas" (
    "id" TEXT NOT NULL,
    "siteVisitId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "squareMeters" INTEGER,
    "rooms" DECIMAL(4,1),
    "bathrooms" INTEGER,
    "windows" INTEGER,
    "frequency" "Frequency" NOT NULL DEFAULT 'ONCE',
    "extras" JSONB NOT NULL DEFAULT '[]',
    "manualHours" DECIMAL(6,2),
    "note" TEXT,

    CONSTRAINT "site_visit_areas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_visits_quoteId_key" ON "site_visits"("quoteId");

-- CreateIndex
CREATE INDEX "site_visits_organizationId_status_scheduledAt_idx" ON "site_visits"("organizationId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_visits_organizationId_number_key" ON "site_visits"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "site_visit_areas_siteVisitId_position_key" ON "site_visit_areas"("siteVisitId", "position");

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visit_areas" ADD CONSTRAINT "site_visit_areas_siteVisitId_fkey" FOREIGN KEY ("siteVisitId") REFERENCES "site_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visit_areas" ADD CONSTRAINT "site_visit_areas_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
--  Von Hand
-- ===========================================================================

-- Eine Besichtigung gehört zu einer Anfrage oder einer Kundschaft — sonst
-- weiss niemand, für wen die Offerte ist.
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_bezug"
  CHECK ("leadId" IS NOT NULL OR "customerId" IS NOT NULL);

-- Eine Offerte entsteht nur aus einer durchgeführten Besichtigung.
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_offerte_nach_besichtigung"
  CHECK ("quoteId" IS NULL OR "status" = 'DONE');

ALTER TABLE "site_visit_areas" ADD CONSTRAINT "site_visit_areas_masse_positiv"
  CHECK (
    ("squareMeters" IS NULL OR "squareMeters" > 0) AND
    ("rooms" IS NULL OR "rooms" > 0) AND
    ("bathrooms" IS NULL OR "bathrooms" >= 0) AND
    ("windows" IS NULL OR "windows" >= 0) AND
    ("manualHours" IS NULL OR "manualHours" > 0)
  );
