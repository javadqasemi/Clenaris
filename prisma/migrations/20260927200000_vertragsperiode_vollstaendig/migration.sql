-- Vertragsperiode einer Rechnung: Beginn und Ende gemeinsam oder gar nicht
-- (2026-09-27, Befund N-06).
--
-- Die Ausschlussbedingung `invoices_vertragsperiode_ueberlappungsfrei`
-- (Migration `20260923100000_vertragsintegritaet`) gilt nur für Zeilen mit
-- `"contractPeriodEnd" IS NOT NULL`. Eine Zeile mit Beginn und ohne Ende
-- entging ihr damit vollständig und konnte sich mit jeder abgerechneten
-- Periode desselben Vertrags überlappen. Der Anwendungsweg
-- (`contract-billing.service.ts` → `createInvoice({ vertrag })`) setzt immer
-- beide Werte; offen war der Weg an der Anwendung vorbei — ein Skript, eine
-- Handkorrektur, ein künftiger zweiter Aufrufer.
--
-- Verworfen: das Prädikat der Ausschlussbedingung zu lockern, damit
-- `daterange(start, NULL)` als „offen nach hinten" mitzählt. Das hätte eine
-- halbe Periode zur gültigen Form erklärt; eine Rechnung über einen
-- Vertragszeitraum ohne Ende gibt es fachlich nicht. Die Bedingung hier macht
-- sie unmöglich, und die Ausschlussbedingung bleibt, wie sie ist.
--
-- Prisma kennt keine CHECK-Bedingungen: `prisma validate` sieht sie nicht,
-- und ein späteres `migrate dev` bietet an, sie zu entfernen — nicht annehmen.
-- Vor dem Anlegen wird geprüft, dass keine Bestandszeile verletzt; sonst
-- bricht die Migration mit einer sprechenden Meldung ab, statt still zu
-- bereinigen.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "invoices"
    WHERE ("contractPeriodStart" IS NULL) <> ("contractPeriodEnd" IS NULL)
  ) THEN
    RAISE EXCEPTION 'invoices: Zeilen mit halber Vertragsperiode vorhanden — erst von Hand prüfen und berichtigen';
  END IF;
END $$;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_vertragsperiode_vollstaendig"
  CHECK (("contractPeriodStart" IS NULL) = ("contractPeriodEnd" IS NULL));
