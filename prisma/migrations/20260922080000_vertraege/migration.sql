-- Wave 10 — Verträge, Vertragsversionen, Leistungsumfang, Einsatzpläne,
-- Änderungsanträge und Preisanpassungen.
--
-- Vollständig additiv: neun Aufzählungstypen, sieben Tabellen, sechs Spalten
-- an bestehenden Tabellen. Kein DROP, kein ALTER COLUMN, keine Rückfüllung.
--
-- Zwei Dinge stehen hier von Hand und nicht aus `prisma migrate diff`:
--
--  1. Der **partielle eindeutige Index** auf der aktiven Vertragsversion.
--     Prisma kann keine Teilindizes ausdrücken; ohne ihn wäre „genau eine
--     gültige Fassung" eine Zusage der Oberfläche und keine der Datenbank.
--     Ein Vertrag mit zwei aktiven Versionen ist kein Anzeigefehler, sondern
--     eine falsche Rechnung.
--
--  2. Zwei Zeilen, die `migrate diff` vorschlägt und die hier **fehlen**:
--     `ALTER TABLE "payroll_settings" ALTER COLUMN "updatedAt" DROP DEFAULT`
--     und dasselbe für `payslips`. Der Vorgabewert wurde in Wave 9 von Hand
--     ergänzt, weil `ADD COLUMN … NOT NULL` ohne ihn auf jeder nicht leeren
--     Tabelle scheitert. Ihn jetzt zu entfernen wäre eine Änderung, die mit
--     Verträgen nichts zu tun hat — und sie würde genau die Migration wieder
--     kaputt machen, die ihn gebraucht hat. `migrate diff` wird ihn weiterhin
--     vorschlagen; das ist bekannt und beabsichtigt.

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'OFFERED', 'ACTIVE', 'PAUSED', 'NOTICE_GIVEN', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContractRenewalType" AS ENUM ('NONE', 'AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "ContractBillingCycle" AS ENUM ('PER_VISIT', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');

-- CreateEnum
CREATE TYPE "ContractPricingModel" AS ENUM ('FIXED_PERIOD', 'FIXED_PER_VISIT', 'HOURLY', 'UNIT_BASED', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ContractVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ContractAmendmentType" AS ENUM ('SCOPE', 'PRICE', 'FREQUENCY', 'TERM', 'SLA', 'PAYMENT_TERMS', 'INDEXATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ContractAmendmentStatus" AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'EFFECTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContractPriceAdjustmentStatus" AS ENUM ('PLANNED', 'APPROVED', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ScheduleHolidayHandling" AS ENUM ('IGNORE', 'SKIP', 'MOVE_BEFORE', 'MOVE_AFTER');

-- CreateEnum
CREATE TYPE "ScheduleExceptionKind" AS ENUM ('SKIP', 'MOVE', 'EXTRA');

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "contractId" TEXT;

-- AlterTable
ALTER TABLE "file_assets" ADD COLUMN     "contractId" TEXT;

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "contractVersionId" TEXT,
ADD COLUMN     "scheduleDate" DATE,
ADD COLUMN     "serviceScheduleId" TEXT;

-- AlterTable
ALTER TABLE "signature_requests" ADD COLUMN     "contractVersionId" TEXT;

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT,
    "quoteId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "responsibleEmployeeId" TEXT,
    "salesOwnerId" TEXT,
    "serviceManagerId" TEXT,
    "costCenter" TEXT,
    "noticeGivenAt" TIMESTAMPTZ(6),
    "noticeGivenBy" TEXT,
    "noticeDeadline" DATE,
    "terminationEffectiveAt" DATE,
    "terminationReason" TEXT,
    "pausedFrom" DATE,
    "pausedUntil" DATE,
    "pauseReason" TEXT,
    "internalNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_versions" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "ContractVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" DATE NOT NULL,
    "effectiveUntil" DATE,
    "reason" TEXT NOT NULL,
    "minimumTermMonths" INTEGER,
    "renewalType" "ContractRenewalType" NOT NULL DEFAULT 'NONE',
    "renewalPeriodMonths" INTEGER,
    "noticePeriodDays" INTEGER NOT NULL DEFAULT 90,
    "billingCycle" "ContractBillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "paymentTermDays" INTEGER NOT NULL DEFAULT 30,
    "currency" TEXT NOT NULL DEFAULT 'CHF',
    "pricingModel" "ContractPricingModel" NOT NULL DEFAULT 'FIXED_PERIOD',
    "baseAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hourlyRate" DECIMAL(12,2),
    "unitPrice" DECIMAL(12,4),
    "unitLabel" TEXT,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 8.1,
    "indexReference" TEXT,
    "indexBaseValue" DECIMAL(12,4),
    "nextReviewAt" DATE,
    "targetQualityScore" INTEGER,
    "inspectionIntervalDays" INTEGER,
    "responseHours" INTEGER,
    "slaNote" TEXT,
    "terms" TEXT,
    "internalNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_services" (
    "id" TEXT NOT NULL,
    "contractVersionId" TEXT NOT NULL,
    "serviceId" TEXT,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "buildingId" TEXT,
    "zone" TEXT,
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 120,
    "requiredCrewSize" INTEGER NOT NULL DEFAULT 1,
    "requiredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "qualityRequirement" TEXT,
    "specialInstructions" TEXT,
    "materialsBy" TEXT NOT NULL DEFAULT 'PROVIDER',
    "quantity" DECIMAL(12,3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_schedules" (
    "id" TEXT NOT NULL,
    "contractServiceId" TEXT NOT NULL,
    "frequency" "Frequency" NOT NULL DEFAULT 'WEEKLY',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "monthDay" INTEGER,
    "startMinute" INTEGER NOT NULL DEFAULT 360,
    "endMinute" INTEGER NOT NULL DEFAULT 600,
    "effectiveFrom" DATE NOT NULL,
    "effectiveUntil" DATE,
    "holidayHandling" "ScheduleHolidayHandling" NOT NULL DEFAULT 'SKIP',
    "generatedUntil" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_exceptions" (
    "id" TEXT NOT NULL,
    "serviceScheduleId" TEXT NOT NULL,
    "kind" "ScheduleExceptionKind" NOT NULL,
    "originalDate" DATE NOT NULL,
    "newDate" DATE,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_amendments" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "type" "ContractAmendmentType" NOT NULL,
    "status" "ContractAmendmentStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reason" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveFrom" DATE NOT NULL,
    "approvedAt" TIMESTAMPTZ(6),
    "rejectedAt" TIMESTAMPTZ(6),
    "rejectReason" TEXT,
    "appliedAt" TIMESTAMPTZ(6),
    "requestedById" TEXT,
    "approvedById" TEXT,
    "previousVersionId" TEXT,
    "newVersionId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_price_adjustments" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "contractVersionId" TEXT,
    "status" "ContractPriceAdjustmentStatus" NOT NULL DEFAULT 'PLANNED',
    "effectiveFrom" DATE NOT NULL,
    "reviewDueAt" DATE,
    "oldAmount" DECIMAL(12,2) NOT NULL,
    "newAmount" DECIMAL(12,2) NOT NULL,
    "percent" DECIMAL(6,3),
    "indexReference" TEXT,
    "indexOldValue" DECIMAL(12,4),
    "indexNewValue" DECIMAL(12,4),
    "reason" TEXT NOT NULL,
    "proposedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(6),
    "appliedAt" TIMESTAMPTZ(6),
    "rejectedAt" TIMESTAMPTZ(6),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contract_price_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contracts_organizationId_status_startDate_idx" ON "contracts"("organizationId", "status", "startDate");

-- CreateIndex
CREATE INDEX "contracts_organizationId_deletedAt_idx" ON "contracts"("organizationId", "deletedAt");

-- CreateIndex
CREATE INDEX "contracts_customerId_idx" ON "contracts"("customerId");

-- CreateIndex
CREATE INDEX "contracts_organizationId_noticeDeadline_idx" ON "contracts"("organizationId", "noticeDeadline");

-- CreateIndex
CREATE INDEX "contracts_organizationId_endDate_idx" ON "contracts"("organizationId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_organizationId_number_key" ON "contracts"("organizationId", "number");

-- CreateIndex
CREATE INDEX "contract_versions_contractId_status_idx" ON "contract_versions"("contractId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_contractId_versionNumber_key" ON "contract_versions"("contractId", "versionNumber");

-- CreateIndex
CREATE INDEX "contract_services_contractVersionId_idx" ON "contract_services"("contractVersionId");

-- CreateIndex
CREATE INDEX "service_schedules_contractServiceId_active_idx" ON "service_schedules"("contractServiceId", "active");

-- CreateIndex
CREATE INDEX "schedule_exceptions_serviceScheduleId_idx" ON "schedule_exceptions"("serviceScheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_exceptions_serviceScheduleId_originalDate_key" ON "schedule_exceptions"("serviceScheduleId", "originalDate");

-- CreateIndex
CREATE INDEX "contract_amendments_contractId_status_idx" ON "contract_amendments"("contractId", "status");

-- CreateIndex
CREATE INDEX "contract_price_adjustments_contractId_status_idx" ON "contract_price_adjustments"("contractId", "status");

-- CreateIndex
CREATE INDEX "contract_price_adjustments_contractId_reviewDueAt_idx" ON "contract_price_adjustments"("contractId", "reviewDueAt");

-- CreateIndex
CREATE INDEX "activities_contractId_occurredAt_idx" ON "activities"("contractId", "occurredAt");

-- CreateIndex
CREATE INDEX "jobs_contractId_idx" ON "jobs"("contractId");

-- CreateIndex
-- Die Doppelsperre des Serienplaners: ein Einsatz je Serie und Kalendertag.
-- Ein gewöhnlicher eindeutiger Index genügt, weil Postgres zwei NULL als
-- verschieden behandelt — Einsätze ohne Serie kollidieren deshalb nie.
CREATE UNIQUE INDEX "jobs_serviceScheduleId_scheduleDate_key" ON "jobs"("serviceScheduleId", "scheduleDate");

-- CreateIndex
CREATE INDEX "signature_requests_contractVersionId_idx" ON "signature_requests"("contractVersionId");

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contractVersionId_fkey" FOREIGN KEY ("contractVersionId") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_serviceScheduleId_fkey" FOREIGN KEY ("serviceScheduleId") REFERENCES "service_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_contractVersionId_fkey" FOREIGN KEY ("contractVersionId") REFERENCES "contract_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_responsibleEmployeeId_fkey" FOREIGN KEY ("responsibleEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_salesOwnerId_fkey" FOREIGN KEY ("salesOwnerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_serviceManagerId_fkey" FOREIGN KEY ("serviceManagerId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_services" ADD CONSTRAINT "contract_services_contractVersionId_fkey" FOREIGN KEY ("contractVersionId") REFERENCES "contract_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_services" ADD CONSTRAINT "contract_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_services" ADD CONSTRAINT "contract_services_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_schedules" ADD CONSTRAINT "service_schedules_contractServiceId_fkey" FOREIGN KEY ("contractServiceId") REFERENCES "contract_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_serviceScheduleId_fkey" FOREIGN KEY ("serviceScheduleId") REFERENCES "service_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_newVersionId_fkey" FOREIGN KEY ("newVersionId") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_price_adjustments" ADD CONSTRAINT "contract_price_adjustments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_price_adjustments" ADD CONSTRAINT "contract_price_adjustments_contractVersionId_fkey" FOREIGN KEY ("contractVersionId") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Von Hand: genau eine gültige Vertragsversion
-- ---------------------------------------------------------------------------
--
-- Prisma kann keine Teilindizes ausdrücken, und dieser trägt die zentrale
-- Zusicherung des ganzen Moduls: Zu jedem Zeitpunkt gilt **eine** Fassung der
-- Konditionen. Entwürfe und abgelöste Fassungen dürfen beliebig oft
-- danebenstehen — sie rechnen nicht mit.
--
-- Die Alternative wäre eine Prüfung im Dienst. Die reicht nicht: Zwischen
-- „gibt es schon eine aktive?" und dem `UPDATE` liegt ein Moment, und zwei
-- gleichzeitige Freigaben passen genau hinein. Dann hätte ein Vertrag zwei
-- Preise, und welcher gilt, entschiede die Sortierung einer Abfrage.
--
-- **Ein späteres `prisma migrate dev` wird anbieten, diesen Index zu
-- entfernen — das ist abzulehnen.** Dasselbe gilt für die Teilindizes aus
-- `…_signatur_kern`, `…_offert_annahme_eindeutig` und `…_vor_ort_abnahme`.
CREATE UNIQUE INDEX "contract_versions_eine_aktive"
  ON "contract_versions" ("contractId")
  WHERE "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------
--  Von Hand: ein offener Änderungsantrag je Vertrag
-- ---------------------------------------------------------------------------
--
-- Zwei gleichzeitig laufende Änderungsanträge auf demselben Vertrag wären
-- nicht mehr Flexibilität, sondern zwei Fassungen der Zukunft: Wird der eine
-- wirksam, bezieht sich der andere auf eine Version, die es nicht mehr gibt.
-- Wer zwei Dinge ändern will, ändert sie in einem Antrag.
CREATE UNIQUE INDEX "contract_amendments_ein_offener"
  ON "contract_amendments" ("contractId")
  WHERE "status" IN ('DRAFT', 'REVIEW', 'APPROVED');
