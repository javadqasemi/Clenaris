-- Verrechnungsanspruch, Qualifikationen, Rotationsvermerk (2026-09-27) — additiv.
--
-- 1. `jobs.billedInvoiceId`: die gültige Rechnung, die einen Einsatz
--    verrechnet. Gesetzt in der Transaktion der Rechnung mit einer bedingten
--    Aktualisierung (`WHERE "billedInvoiceId" IS NULL`); Storno und
--    gelöschter Entwurf geben ihn frei. Ersetzt die Vorprüfung ausserhalb
--    der Transaktion, unter der fünf gleichzeitige Aufrufe drei Rechnungen
--    für denselben Einsatz ergaben. Begründung am Modell.
-- 2. `jobs.requiredSkills`, `services.requiredSkills`: Qualifikationen, die
--    die Zuteilung prüft (`assignment.service.ts`). Leer = keine Vorgabe,
--    für jeden bestehenden Datensatz.
-- 3. `refresh_tokens.rotatedAt`: unterscheidet „durch Rotation verbraucht"
--    von „abgemeldet/eingeschlafen/gesperrt" — ein verlorener Wettlauf
--    zweier Tabs ist keine Wiederverwendung.
--
-- Rückfüllung von (1): Je Einsatz die älteste gültige Rechnung (nicht
-- storniert, nicht gelöscht), die ihn in einer Position trägt. Stand er —
-- durch genau den behobenen Wettlauf — auf zwei gültigen Rechnungen, bleibt
-- der Anspruch bei der ersten; die zweite ist ein Befund für die
-- Buchhaltung, keiner, den eine Migration still entscheiden sollte. Die
-- Rechnungen selbst werden nicht angefasst (sie sind unveränderlich).

ALTER TABLE "jobs" ADD COLUMN "billedInvoiceId" TEXT;
ALTER TABLE "jobs" ADD COLUMN "requiredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "services" ADD COLUMN "requiredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "refresh_tokens" ADD COLUMN "rotatedAt" TIMESTAMPTZ(6);

CREATE INDEX "jobs_billedInvoiceId_idx" ON "jobs"("billedInvoiceId");

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_billedInvoiceId_fkey"
  FOREIGN KEY ("billedInvoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "jobs" j
   SET "billedInvoiceId" = s."invoiceId"
  FROM (
    SELECT DISTINCT ON (ii."jobId") ii."jobId", i."id" AS "invoiceId"
      FROM "invoice_items" ii
      JOIN "invoices" i ON i."id" = ii."invoiceId"
     WHERE ii."jobId" IS NOT NULL
       AND i."status" <> 'CANCELLED'
       AND i."deletedAt" IS NULL
     ORDER BY ii."jobId", i."createdAt", i."id"
  ) s
 WHERE j."id" = s."jobId";
