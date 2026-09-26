-- Scanplattform (2026-09-26): Herstellerstrichcode am Material, eigene
-- Etikettcodes und ein Index für die QR-Referenz der Rechnung.
--
-- Nur hinzufügend. Die beiden `updatedAt DROP DEFAULT`, die `migrate diff`
-- gegen die Testdatenbank zusätzlich vorschlug (payroll_settings, payslips),
-- sind eine ältere, bekannte Abweichung und gehören nicht in diese Migration.

-- CreateEnum
CREATE TYPE "ScanEntity" AS ENUM ('MATERIAL', 'EQUIPMENT', 'PROPERTY', 'JOB');

-- AlterTable
ALTER TABLE "materials" ADD COLUMN "barcode" TEXT;

-- CreateTable
CREATE TABLE "scan_codes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entityType" "ScanEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedById" TEXT,

    CONSTRAINT "scan_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scan_codes_code_key" ON "scan_codes"("code");

-- CreateIndex
CREATE INDEX "scan_codes_organizationId_entityType_entityId_idx" ON "scan_codes"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "invoices_organizationId_qrReference_idx" ON "invoices"("organizationId", "qrReference");

-- CreateIndex
-- Postgres behandelt NULL als verschieden: Artikel ohne Strichcode stören
-- einander nicht, zwei Artikel mit demselben Strichcode schon.
CREATE UNIQUE INDEX "materials_organizationId_barcode_key" ON "materials"("organizationId", "barcode");

-- AddForeignKey
ALTER TABLE "scan_codes" ADD CONSTRAINT "scan_codes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Von Hand (Prisma kann Teilindizes nicht ausdrücken; ein späteres
-- `migrate dev` wird anbieten, ihn zu löschen — nicht annehmen):
--
-- Höchstens ein aktiver Code je Datensatz. Ohne diesen Index legten zwei
-- gleichzeitige „Etikett erzeugen" zwei gültige Codes an, und das Sperren des
-- einen liesse den anderen weiterleben — genau der Aufkleber, den man für
-- zurückgezogen hält, öffnete dann weiterhin den Datensatz. Gesperrte Codes
-- bleiben stehen (Nachweis, was einmal gedruckt war) und fallen aus dem Index.
CREATE UNIQUE INDEX "scan_codes_ein_aktiver_je_datensatz"
  ON "scan_codes"("organizationId", "entityType", "entityId")
  WHERE "revokedAt" IS NULL;
