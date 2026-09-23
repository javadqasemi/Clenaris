-- Wave 13 (2026-09-23): ausdrückliche Freigabe der Datenbereinigung.
--
-- Die Trigger aus `20260923200000_finanzen_unveraenderlich` verweigern das
-- Löschen ausgestellter Finanzbelege. Die Datenbereinigung
-- (`purge.service.ts`, nur Systemverantwortung, protokolliert, mit Warnung zu
-- Art. 957a OR) leert Demo- und Testbestände und muss das weiterhin können.
--
-- Sie setzt dafür in ihrer Transaktion `SET LOCAL clenaris.bereinigung = 'on'`.
-- Das ist kein Schlupfloch für versehentliche Änderungen: Kein anderer
-- Codepfad setzt die Einstellung, sie gilt nur bis zum Transaktionsende, und
-- sie muss ausdrücklich geschrieben werden. `session_replication_role` wäre
-- die Alternative — verlangt aber eine Superuser-Rolle, die die Anwendung in
-- der Produktion nicht hat.
--
-- Nur das Löschen wird freigegeben; Änderungen am Inhalt bleiben auch in der
-- Bereinigung verboten (sie löscht, sie ändert nicht).

CREATE OR REPLACE FUNCTION bereinigung_freigegeben() RETURNS boolean AS $$
  SELECT coalesce(current_setting('clenaris.bereinigung', true), '') = 'on';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION rechnung_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' AND NOT bereinigung_freigegeben() THEN
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

CREATE OR REPLACE FUNCTION gutschrift_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF bereinigung_freigegeben() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Gutschrift % wird nicht gelöscht (Art. 957a OR).', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'pdfUrl') IS DISTINCT FROM (to_jsonb(OLD) - 'pdfUrl') THEN
    RAISE EXCEPTION 'Gutschrift % ist unveränderlich.', OLD."number" USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION zahlung_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF bereinigung_freigegeben() THEN
      RETURN OLD;
    END IF;
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
