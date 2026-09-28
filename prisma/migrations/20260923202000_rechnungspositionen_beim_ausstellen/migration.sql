-- Wave 13 (2026-09-23): Positionen einer Rechnung, die im selben Schritt
-- angelegt und ausgestellt wird.
--
-- `createInvoice` mit `issueImmediately` (Sammelrechnung aus Einsätzen,
-- Rechnung aus Offerte, Vertragsabrechnung) legt die Rechnung gleich als
-- `ISSUED` an und schreibt die Positionen danach in derselben Transaktion.
-- Der Trigger aus `20260923200000_finanzen_unveraenderlich` hielt das für
-- ein Nachschieben von Positionen und brach jede Sofortausstellung ab.
--
-- Unterschieden wird jetzt am Entstehen der Rechnung: Wurde ihre Zeile von
-- **dieser** Transaktion geschrieben (`xmin` ist die laufende Transaktion)
-- und ist sie jünger als zehn Minuten, gehören die Positionen zum
-- Ausstellen. `createdAt = now()` wäre schärfer, trifft aber nicht: Prisma
-- setzt `@default(now())` im Abfragemotor, nicht in der Datenbank, und die
-- Zeit weicht um Millisekunden ab. Die zehn Minuten schliessen den Fall aus,
-- der zählt — eine früher ausgestellte Rechnung, deren Lebenslauf dieselbe
-- Transaktion fortschreibt, ist älter.

CREATE OR REPLACE FUNCTION rechnungsposition_unveraenderlich() RETURNS trigger AS $$
DECLARE
  stand "InvoiceStatus";
  eben_angelegt boolean;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "status", (xmin = pg_current_xact_id()::xid AND "createdAt" > now() - interval '10 minutes')
    INTO stand, eben_angelegt
    FROM "invoices" WHERE "id" = COALESCE(NEW."invoiceId", OLD."invoiceId");
  IF stand IS NOT NULL AND stand <> 'DRAFT' THEN
    IF NOT (TG_OP = 'INSERT' AND eben_angelegt) THEN
      RAISE EXCEPTION 'Die Positionen einer ausgestellten Rechnung sind unveränderlich.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId" THEN
    SELECT "status" INTO stand FROM "invoices" WHERE "id" = NEW."invoiceId";
    IF stand IS NOT NULL AND stand <> 'DRAFT' THEN
      RAISE EXCEPTION 'Eine Position wird nicht in eine ausgestellte Rechnung verschoben.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
