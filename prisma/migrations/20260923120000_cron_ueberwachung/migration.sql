-- Überwachung der geplanten Läufe (RB-014) und eine Nummernsperre (M-8).
--
-- Additiv. Aus `prisma migrate diff` gegen die Entwicklungsdatenbank; nicht
-- übernommen ist der `DROP DEFAULT` auf `payroll_settings`/`payslips`, den
-- Prisma bei jedem Diff vorschlägt (dieselbe Entscheidung wie zuvor).

-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "cron_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "error" TEXT,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_runs_organizationId_job_startedAt_idx" ON "cron_runs"("organizationId", "job", "startedAt");

-- AddForeignKey
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Eine Nummer der Qualitätskontrolle je Organisation genau einmal.
--
-- Die Nummer kommt aus dem Nummernkreis, und der vergibt keine doppelt. Der
-- Index ist trotzdem da: Bis 2026-09-23 konnten zwei gleichzeitige Abschlüsse
-- beide schreiben (der Dienst prüft das heute in der Bedingung des Schreibens),
-- und eine Zusicherung, die nur in einem Codepfad steht, umgeht der nächste.
-- Partiell, weil ein Entwurf noch keine Nummer hat.
CREATE UNIQUE INDEX "quality_inspections_nummer_einmal"
    ON "quality_inspections" ("organizationId", "number")
 WHERE "number" IS NOT NULL;
