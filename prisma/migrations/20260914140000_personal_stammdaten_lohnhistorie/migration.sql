-- Personalakte: Geburtsdatum, Wohnadresse, interne Notizen; Lohnhistorie.
--
-- Rein additiv. Die Lohnhistorie wird für bestehende Akten mit einer
-- Ausgangszeile ab Eintritt befüllt, damit der heutige Lohn belegt ist und
-- die erste echte Änderung nicht die einzige Zeile bleibt.

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "birthday" DATE,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "street" TEXT;

-- CreateTable
CREATE TABLE "salary_records" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "hourlyRate" DECIMAL(12,2),
    "monthlySalary" DECIMAL(12,2),
    "workloadPct" INTEGER NOT NULL DEFAULT 100,
    "reason" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salary_records_employeeId_validFrom_idx" ON "salary_records"("employeeId", "validFrom");

-- AddForeignKey
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ausgangszeile je bestehender Akte mit Lohnangabe
INSERT INTO "salary_records" ("id", "employeeId", "validFrom", "hourlyRate", "monthlySalary", "workloadPct", "reason")
SELECT
    'sal' || substr(md5(random()::text || "id"), 1, 22),
    "id",
    "hiredAt",
    "hourlyRate",
    "monthlySalary",
    "workloadPct",
    'Stand bei Einführung der Lohnhistorie'
FROM "employees"
WHERE "hourlyRate" IS NOT NULL OR "monthlySalary" IS NOT NULL;
