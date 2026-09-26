-- Sicherheitsberichte (2026-09-26): Ergebnisse von Prüfungen ausserhalb der
-- Anwendung — security:check, externer Überwachungsrechner, ZAP-Grundprüfung,
-- Sicherung — für die Sicherheitszentrale.
--
-- Nur hinzufügend. Die beiden `updatedAt DROP DEFAULT` (payroll_settings,
-- payslips), die `migrate diff` zusätzlich vorschlägt, sind die bekannte
-- ältere Abweichung und gehören nicht hierher.

-- CreateEnum
CREATE TYPE "SecurityReportSource" AS ENUM ('SECURITY_CHECK', 'EXTERNAL_MONITOR', 'ZAP_BASELINE', 'DEPENDENCY_CHECK', 'BACKUP', 'HOST_INTEGRITY');

-- CreateEnum
CREATE TYPE "SecurityReportStatus" AS ENUM ('OK', 'WARNUNG', 'KRITISCH', 'NICHT_GEPRUEFT');

-- CreateTable
CREATE TABLE "security_reports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" "SecurityReportSource" NOT NULL,
    "status" "SecurityReportStatus" NOT NULL,
    "version" TEXT,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "reportedAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_reports_organizationId_source_receivedAt_idx" ON "security_reports"("organizationId", "source", "receivedAt");

-- AddForeignKey
ALTER TABLE "security_reports" ADD CONSTRAINT "security_reports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
