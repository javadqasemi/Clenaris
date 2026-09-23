-- Wave 13 (2026-09-23): Unveränderlichkeit der Finanzbelege in der Datenbank.
--
-- Bis hierher stand die Regel „eine ausgestellte Rechnung wird nie geändert
-- oder gelöscht" nur im Dienst (`invoice.service.ts`, `trash.service.ts`).
-- Ein Skript, eine künftige Route oder ein Handgriff in der Datenbank hätte sie
-- umgehen können — und eine veränderte Rechnung sieht aus wie eine richtige.
-- Art. 957a OR verlangt revisionssichere, lückenlose Belege; die Datenbank
-- ist die letzte Stelle, an der das durchgesetzt werden kann.
--
-- Kein Schemawechsel: nur Trigger. Kaskaden (pg_trigger_depth() > 1) bleiben
-- erlaubt — das Löschen einer ganzen Organisation muss möglich bleiben.
--
-- Was nach dem Ausstellen änderbar bleibt, ist der **Lebenslauf**, nicht der
-- **Inhalt**: Status, Versand-/Ansichts-/Zahlungs-/Stornozeitpunkte,
-- bezahlter Betrag und Saldo, Mahnstufe, interne Notiz, PDF-Adresse,
-- Stripe-Verweise und — für das Zusammenführen doppelter Kundenakten — der
-- Verweis auf die Kundschaft. Der Empfänger-Schnappschuss (billTo*) bleibt
-- dabei unverändert; er ist, was auf dem Beleg steht.

-- ---------------------------------------------------------------------------
--  Rechnungen
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rechnung_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Rechnung % ist ausgestellt und wird nicht gelöscht (Art. 957a OR) — Storno oder Gutschrift.', OLD."number"
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Eine ausgestellte Rechnung wird nicht wieder zum Entwurf.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    RAISE EXCEPTION 'Rechnung % ist ausgestellt und wird nicht gelöscht.', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."quoteId" IS DISTINCT FROM OLD."quoteId"
     OR NEW."contractId" IS DISTINCT FROM OLD."contractId"
     OR NEW."contractVersionId" IS DISTINCT FROM OLD."contractVersionId"
     OR NEW."contractPeriodStart" IS DISTINCT FROM OLD."contractPeriodStart"
     OR NEW."contractPeriodEnd" IS DISTINCT FROM OLD."contractPeriodEnd"
     OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate"
     OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
     OR NEW."periodFrom" IS DISTINCT FROM OLD."periodFrom"
     OR NEW."periodTo" IS DISTINCT FROM OLD."periodTo"
     OR NEW."billToName" IS DISTINCT FROM OLD."billToName"
     OR NEW."billToCompany" IS DISTINCT FROM OLD."billToCompany"
     OR NEW."billToStreet" IS DISTINCT FROM OLD."billToStreet"
     OR NEW."billToZip" IS DISTINCT FROM OLD."billToZip"
     OR NEW."billToCity" IS DISTINCT FROM OLD."billToCity"
     OR NEW."billToCountry" IS DISTINCT FROM OLD."billToCountry"
     OR NEW."billToEmail" IS DISTINCT FROM OLD."billToEmail"
     OR NEW."billToVat" IS DISTINCT FROM OLD."billToVat"
     OR NEW."introText" IS DISTINCT FROM OLD."introText"
     OR NEW."outroText" IS DISTINCT FROM OLD."outroText"
     OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
     OR NEW."discountAmount" IS DISTINCT FROM OLD."discountAmount"
     OR NEW."netTotal" IS DISTINCT FROM OLD."netTotal"
     OR NEW."vatAmount" IS DISTINCT FROM OLD."vatAmount"
     OR NEW."grossTotal" IS DISTINCT FROM OLD."grossTotal"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."qrReference" IS DISTINCT FROM OLD."qrReference"
     OR NEW."publicToken" IS DISTINCT FROM OLD."publicToken" THEN
    RAISE EXCEPTION 'Rechnung % ist ausgestellt — ihr Inhalt ist unveränderlich. Korrektur über Storno oder Gutschrift.', OLD."number"
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rechnung_unveraenderlich
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION rechnung_unveraenderlich();

-- Positionen einer ausgestellten Rechnung: weder hinzufügen noch ändern noch entfernen.
CREATE OR REPLACE FUNCTION rechnungsposition_unveraenderlich() RETURNS trigger AS $$
DECLARE
  stand "InvoiceStatus";
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "status" INTO stand FROM "invoices" WHERE "id" = COALESCE(NEW."invoiceId", OLD."invoiceId");
  IF stand IS NOT NULL AND stand <> 'DRAFT' THEN
    RAISE EXCEPTION 'Die Positionen einer ausgestellten Rechnung sind unveränderlich.' USING ERRCODE = 'P0001';
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

CREATE TRIGGER rechnungsposition_unveraenderlich
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_items"
  FOR EACH ROW EXECUTE FUNCTION rechnungsposition_unveraenderlich();

-- ---------------------------------------------------------------------------
--  Gutschriften — ab dem Anlegen ausgestellt; nur die PDF-Adresse kommt nach
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gutschrift_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Gutschrift % wird nicht gelöscht (Art. 957a OR).', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'pdfUrl') IS DISTINCT FROM (to_jsonb(OLD) - 'pdfUrl') THEN
    RAISE EXCEPTION 'Gutschrift % ist unveränderlich.', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gutschrift_unveraenderlich
  BEFORE UPDATE OR DELETE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION gutschrift_unveraenderlich();

-- ---------------------------------------------------------------------------
--  Mahnungen — ein versandter Beleg; nur die PDF-Adresse kommt nach
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mahnung_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Eine versandte Mahnung wird nicht gelöscht.' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'pdfUrl') IS DISTINCT FROM (to_jsonb(OLD) - 'pdfUrl') THEN
    RAISE EXCEPTION 'Eine versandte Mahnung ist unveränderlich.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mahnung_unveraenderlich
  BEFORE UPDATE OR DELETE ON "payment_reminders"
  FOR EACH ROW EXECUTE FUNCTION mahnung_unveraenderlich();

-- ---------------------------------------------------------------------------
--  Zahlungen — nie löschen; eingegangene Zahlungen behalten Betrag und Bezug
-- ---------------------------------------------------------------------------
--
-- Eine falsch verbuchte Zahlung wird **storniert** (Status CANCELLED) und
-- bleibt als Zeile stehen; der Saldo zählt nur SUCCEEDED. Nach dem Eingang
-- (SUCCEEDED und später) sind Betrag, Währung, Rechnung, Zahlungsart und
-- Anbieterkennung fest; Erstattung, Storno, Beleg, Notiz und Buchungsdatum
-- bleiben änderbar, der Verweis auf die Kundschaft für das Zusammenführen.

CREATE OR REPLACE FUNCTION zahlung_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Zahlungen werden nicht gelöscht — eine falsche Buchung wird storniert.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED') AND (
       NEW."amount" IS DISTINCT FROM OLD."amount"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
       OR NEW."method" IS DISTINCT FROM OLD."method"
       OR NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
     ) THEN
    RAISE EXCEPTION 'Eine eingegangene Zahlung behält Betrag, Währung, Rechnung und Herkunft.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Eine stornierte Zahlung wird nicht wiederbelebt — neu verbuchen.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zahlung_unveraenderlich
  BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION zahlung_unveraenderlich();
