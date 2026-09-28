-- Lohnabrechnung (Wave 9)
--
-- Additiv: eine neue Tabelle und sechs Spalten an `payslips`. Kein DROP, kein
-- verlustbehaftetes ALTER.
--
-- ---------------------------------------------------------------------------
--  Eine Handkorrektur, die nötig war
-- ---------------------------------------------------------------------------
--
-- `prisma migrate diff` erzeugte für `updatedAt` die Zeile
--
--     ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL;
--
-- ohne Vorgabewert. Das ist auf einer **leeren** Tabelle unauffällig und
-- scheitert auf jeder anderen: PostgreSQL kann eine NOT-NULL-Spalte ohne
-- Vorgabe nicht zu vorhandenen Zeilen hinzufügen.
--
-- Hier trifft es zufällig keine Zeile — `payslips` wurde von keinem Codepfad
-- je beschrieben, und genau das ist der Befund dieser Wave. Die Vorgabe steht
-- trotzdem: Die Migration soll auf jeder Datenbank laufen, nicht nur auf
-- dieser, und ein Produktivstand mit Zeilen ist die Datenbank, auf der es
-- zählt.

-- AlterTable
ALTER TABLE "payslips"
    ADD COLUMN     "basis" TEXT NOT NULL DEFAULT 'HOURLY',
    ADD COLUMN     "breakdown" JSONB,
    ADD COLUMN     "createdById" TEXT,
    ADD COLUMN     "ktg" DECIMAL(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN     "publishedAt" TIMESTAMPTZ(6),
    ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "payroll_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "ahvIvEo" DECIMAL(6,3) NOT NULL DEFAULT 5.3,
    "alv" DECIMAL(6,3) NOT NULL DEFAULT 1.1,
    "alvGrenzeJahr" DECIMAL(12,2) NOT NULL DEFAULT 148200,
    "alvUeberGrenze" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "uvgNbu" DECIMAL(6,3) NOT NULL DEFAULT 1.6,
    "ktg" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "bvgEintrittsschwelle" DECIMAL(12,2) NOT NULL DEFAULT 22680,
    "bvgKoordinationsabzug" DECIMAL(12,2) NOT NULL DEFAULT 26460,
    "bvgMindestKoordiniert" DECIMAL(12,2) NOT NULL DEFAULT 3780,
    "bvgObergrenze" DECIMAL(12,2) NOT NULL DEFAULT 90720,
    "bvgSaetze" JSONB NOT NULL DEFAULT '[{"abAlter":25,"satz":7},{"abAlter":35,"satz":10},{"abAlter":45,"satz":15},{"abAlter":55,"satz":18}]',
    "bvgAnteilArbeitnehmer" DECIMAL(6,3) NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- Eine Zeile je Organisation und Jahr. Alte Zeilen bleiben stehen: Eine
-- nachträgliche Korrektur einer Abrechnung von 2025 muss mit den Sätzen von
-- 2025 rechnen. Die Sätze zu überschreiben hiesse, die Vergangenheit
-- umzuschreiben.
CREATE UNIQUE INDEX "payroll_settings_organizationId_year_key" ON "payroll_settings"("organizationId", "year");

-- CreateIndex
CREATE INDEX "payslips_year_month_idx" ON "payslips"("year", "month");

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
