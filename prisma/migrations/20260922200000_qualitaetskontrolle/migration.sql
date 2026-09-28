-- Qualitätskontrolle vor Ort (Wave 11).
--
-- `ContractVersion` trägt seit Wave 10 `targetQualityScore`,
-- `inspectionIntervalDays` und `responseHours`. Die drei Felder wurden
-- gespeichert, angezeigt und gedruckt — und von nichts gemessen. Eine
-- vereinbarte Zusage ohne Mechanismus ist genau das Muster, das die
-- Merkmalsprüfung aufspüren soll; hier hat sie die eigene Wave gefunden.
--
-- Additiv: zwei Tabellen, zwei Aufzählungstypen, keine Änderung an Bestehendem.
--
-- Hinweis: `prisma migrate diff` schlägt weiterhin
--   ALTER TABLE "payroll_settings" ALTER COLUMN "updatedAt" DROP DEFAULT;
--   ALTER TABLE "payslips"         ALTER COLUMN "updatedAt" DROP DEFAULT;
-- vor. Das ist die Handkorrektur aus Wave 9 und wird auch hier nicht
-- übernommen.

-- CreateEnum
CREATE TYPE "QualityInspectionStatus" AS ENUM ('DRAFT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QualityOutcome" AS ENUM ('BESTANDEN', 'KNAPP', 'NICHT_BESTANDEN', 'OHNE_ZIEL');

-- CreateTable
CREATE TABLE "quality_inspections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT,
    "contractId" TEXT,
    "contractVersionId" TEXT,
    "propertyId" TEXT,
    "jobId" TEXT,
    "status" "QualityInspectionStatus" NOT NULL DEFAULT 'DRAFT',
    "inspectedAt" TIMESTAMPTZ(6) NOT NULL,
    "inspectorId" TEXT,
    "scoreAchieved" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "scorePossible" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "scorePercent" DECIMAL(5,2),
    "targetScore" INTEGER,
    "outcome" "QualityOutcome" NOT NULL DEFAULT 'OHNE_ZIEL',
    "note" TEXT,
    "internalNote" TEXT,
    "followUpOfId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "quality_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_inspection_items" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "room" TEXT,
    "points" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "maxPoints" DECIMAL(6,2) NOT NULL DEFAULT 5,
    "weight" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "note" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quality_inspection_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Eine Nachkontrolle je Kontrolle. Zwei wären zwei Korrekturen desselben
-- Belegs, und welche gilt, wäre eine Frage der Reihenfolge.
CREATE UNIQUE INDEX "quality_inspections_followUpOfId_key" ON "quality_inspections"("followUpOfId");

-- CreateIndex
CREATE INDEX "quality_inspections_organizationId_status_inspectedAt_idx" ON "quality_inspections"("organizationId", "status", "inspectedAt");

-- CreateIndex
CREATE INDEX "quality_inspections_contractId_inspectedAt_idx" ON "quality_inspections"("contractId", "inspectedAt");

-- CreateIndex
CREATE INDEX "quality_inspections_propertyId_inspectedAt_idx" ON "quality_inspections"("propertyId", "inspectedAt");

-- CreateIndex
CREATE INDEX "quality_inspection_items_inspectionId_position_idx" ON "quality_inspection_items"("inspectionId", "position");

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_contractVersionId_fkey" FOREIGN KEY ("contractVersionId") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_inspectorId_fkey" FOREIGN KEY ("inspectorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_followUpOfId_fkey" FOREIGN KEY ("followUpOfId") REFERENCES "quality_inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspection_items" ADD CONSTRAINT "quality_inspection_items_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "quality_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Von Hand: eine abgeschlossene Begehung ist ein Beleg
-- ---------------------------------------------------------------------------
--
-- Prisma kann das nicht ausdrücken, und ohne diese Bedingung wäre die
-- Zusicherung nur eine Prüfung im Dienst — also eine, die ein Skript, ein
-- Nachtlauf oder der nächste Codepfad umgeht, ohne es zu merken.
--
-- Zwei Dinge stehen hier:
--
--  1. Eine abgeschlossene Begehung hat eine Nummer und einen Abschlusszeitpunkt.
--     Ein COMPLETED ohne beides wäre ein Beleg, den man nicht zitieren kann.
--  2. Die Punktzahl ist nie grösser als die mögliche. Das fängt den
--     Rechenfehler, den eine Prüfung im Dienst übersieht, sobald jemand
--     daneben schreibt.
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_abgeschlossen_vollstaendig"
  CHECK (
    "status" <> 'COMPLETED'
    OR ("number" IS NOT NULL AND "completedAt" IS NOT NULL)
  );

ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_punkte_plausibel"
  CHECK ("scoreAchieved" >= 0 AND "scorePossible" >= 0 AND "scoreAchieved" <= "scorePossible");
