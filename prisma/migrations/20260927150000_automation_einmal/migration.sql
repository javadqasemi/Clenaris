-- Automatisierung genau einmal je Aktion, Ereignisse in der Transaktion (2026-09-27) — additiv.
--
-- 1. `automation_action_runs`: der Stand jeder einzelnen Aktion eines Laufs.
--    Ein Wiederholungsversuch setzt bei der ersten nicht erfolgreichen fort,
--    statt erfolgreiche Aktionen (Aufgabe, E-Mail) erneut auszuführen.
-- 2. `automation_events`: Transactional Outbox. Die Dienste vermerken ihre
--    Auslöser in der Transaktion des Geschäftsvorgangs; verarbeitet wird
--    danach — im selben Aufruf und, falls das ausbleibt, im stündlichen
--    Lauf. Ein Absturz zwischen Commit und Meldung verliert nichts mehr.
-- Begründungen an den Modellen in `schema.prisma`.

CREATE TYPE "AutomationActionRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

CREATE TABLE "automation_action_runs" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" "AutomationActionRunStatus" NOT NULL DEFAULT 'RUNNING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "automation_action_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automation_action_runs_runId_position_key" ON "automation_action_runs"("runId", "position");

ALTER TABLE "automation_action_runs" ADD CONSTRAINT "automation_action_runs_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "automation_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trigger" "AutomationTrigger" NOT NULL,
    "entityId" TEXT NOT NULL,
    "bezugszeit" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_events_processedAt_createdAt_idx" ON "automation_events"("processedAt", "createdAt");
