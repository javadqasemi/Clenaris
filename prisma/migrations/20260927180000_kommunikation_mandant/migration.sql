-- Kommunikation bekommt eine Organisation (2026-09-27).
--
-- `message_threads`, `email_logs` und `sms_logs` hatten keine
-- `organizationId`. Die Nachrichtenliste des Büros filterte deshalb gar nicht
-- nach Organisation — nachgewiesen in `tests/api/mandanten.test.ts`: Ein
-- Verlauf einer fremden Organisation stand in der Liste, und eine Antwort
-- darauf wurde angenommen (201). Das Zustellprotokoll zeigte ebenso alle
-- Zeilen aller Organisationen.
--
-- Rückfüllung ohne Raten:
--   • Verläufe tragen die Organisation ihrer Kundschaft, sonst die ihres
--     Einsatzes. Ein Verlauf ohne beides kann über die Anwendung nicht
--     entstehen (POST /api/messages verlangt eines davon, beide Beziehungen
--     löschen kaskadierend). Gäbe es ihn doch, bricht die Migration ab, statt
--     ihn einer Organisation zuzuschlagen, der er vielleicht nicht gehört.
--   • Protokollzeilen tragen die Organisation des Datensatzes, auf den sie
--     verweisen (`entity`/`entityId`), wo diese Tabelle eine hat. Übrig
--     gebliebene Zeilen bekommen die Organisation nur, wenn es genau eine
--     gibt — dann ist die Zuordnung keine Annahme. Sonst bleiben sie leer und
--     erscheinen in keinem Zustellprotokoll: ein fehlender Eintrag ist hier
--     die richtige Richtung des Irrtums, ein fremder nicht.

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "sms_logs" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "message_threads" ADD COLUMN "organizationId" TEXT;

-- Verläufe
UPDATE "message_threads" t SET "organizationId" = c."organizationId"
FROM "customers" c WHERE t."customerId" = c."id" AND t."organizationId" IS NULL;

UPDATE "message_threads" t SET "organizationId" = j."organizationId"
FROM "jobs" j WHERE t."jobId" = j."id" AND t."organizationId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "message_threads" WHERE "organizationId" IS NULL) THEN
    RAISE EXCEPTION 'Nachrichtenverläufe ohne Kundschaft und ohne Einsatz gefunden — keiner Organisation sicher zuzuordnen. Bitte von Hand klären, dann erneut ausführen.';
  END IF;
END $$;

ALTER TABLE "message_threads" ALTER COLUMN "organizationId" SET NOT NULL;

-- Aufgaben: dieselbe Lücke (nachgewiesen: fremde Aufgabe in der Liste,
-- PATCH 200, POST mit fremder Kundschaft 201). Eine Aufgabe kann an nichts
-- hängen; die Reihenfolge der Quellen ist die Stärke des Bezugs — wer sie
-- angelegt hat, dann das fachliche Objekt, zuletzt die zugewiesene Person.
ALTER TABLE "tasks" ADD COLUMN "organizationId" TEXT;
UPDATE "tasks" t SET "organizationId" = u."organizationId" FROM "users" u WHERE t."creatorId" = u."id" AND t."organizationId" IS NULL;
UPDATE "tasks" t SET "organizationId" = x."organizationId" FROM "customers" x WHERE t."customerId" = x."id" AND t."organizationId" IS NULL;
UPDATE "tasks" t SET "organizationId" = x."organizationId" FROM "leads" x WHERE t."leadId" = x."id" AND t."organizationId" IS NULL;
UPDATE "tasks" t SET "organizationId" = x."organizationId" FROM "jobs" x WHERE t."jobId" = x."id" AND t."organizationId" IS NULL;
UPDATE "tasks" t SET "organizationId" = x."organizationId" FROM "objectives" x WHERE t."objectiveId" = x."id" AND t."organizationId" IS NULL;
UPDATE "tasks" t SET "organizationId" = x."organizationId" FROM "meetings" x WHERE t."meetingId" = x."id" AND t."organizationId" IS NULL;
UPDATE "tasks" t SET "organizationId" = u."organizationId" FROM "users" u WHERE t."assigneeId" = u."id" AND t."organizationId" IS NULL;
UPDATE "tasks" SET "organizationId" = (SELECT "id" FROM "organizations")
WHERE "organizationId" IS NULL AND (SELECT count(*) FROM "organizations") = 1;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tasks" WHERE "organizationId" IS NULL) THEN
    RAISE EXCEPTION 'Aufgaben ohne jeden Bezug bei mehreren Organisationen gefunden — keiner sicher zuzuordnen. Bitte von Hand klären, dann erneut ausführen.';
  END IF;
END $$;

ALTER TABLE "tasks" ALTER COLUMN "organizationId" SET NOT NULL;
CREATE INDEX "tasks_organizationId_status_dueAt_idx" ON "tasks"("organizationId", "status", "dueAt");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Protokolle: über den verwiesenen Datensatz
UPDATE "email_logs" l SET "organizationId" = x."organizationId" FROM "bookings" x WHERE l."entity" = 'Booking' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "email_logs" l SET "organizationId" = x."organizationId" FROM "invoices" x WHERE l."entity" = 'Invoice' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "email_logs" l SET "organizationId" = x."organizationId" FROM "quotes" x WHERE l."entity" = 'Quote' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "email_logs" l SET "organizationId" = x."organizationId" FROM "jobs" x WHERE l."entity" = 'Job' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "email_logs" l SET "organizationId" = x."organizationId" FROM "leads" x WHERE l."entity" = 'Lead' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "email_logs" l SET "organizationId" = x."organizationId" FROM "customers" x WHERE l."entity" = 'Customer' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "email_logs" l SET "organizationId" = x."organizationId" FROM "message_threads" x WHERE l."entity" = 'MessageThread' AND l."entityId" = x."id" AND l."organizationId" IS NULL;

UPDATE "sms_logs" l SET "organizationId" = x."organizationId" FROM "bookings" x WHERE l."entity" = 'Booking' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "sms_logs" l SET "organizationId" = x."organizationId" FROM "jobs" x WHERE l."entity" = 'Job' AND l."entityId" = x."id" AND l."organizationId" IS NULL;
UPDATE "sms_logs" l SET "organizationId" = x."organizationId" FROM "customers" x WHERE l."entity" = 'Customer' AND l."entityId" = x."id" AND l."organizationId" IS NULL;

-- Protokolle: der Rest nur, wenn die Zuordnung eindeutig ist
UPDATE "email_logs" SET "organizationId" = (SELECT "id" FROM "organizations")
WHERE "organizationId" IS NULL AND (SELECT count(*) FROM "organizations") = 1;
UPDATE "sms_logs" SET "organizationId" = (SELECT "id" FROM "organizations")
WHERE "organizationId" IS NULL AND (SELECT count(*) FROM "organizations") = 1;

-- CreateIndex
CREATE INDEX "email_logs_organizationId_createdAt_idx" ON "email_logs"("organizationId", "createdAt");
CREATE INDEX "message_threads_organizationId_closed_lastMessageAt_idx" ON "message_threads"("organizationId", "closed", "lastMessageAt");
CREATE INDEX "sms_logs_organizationId_createdAt_idx" ON "sms_logs"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
