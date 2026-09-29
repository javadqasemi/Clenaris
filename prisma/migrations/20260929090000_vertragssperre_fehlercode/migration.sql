-- Prisma 7 (2026-09-29): Die Sperre einer Vertragsfassung meldet sich mit
-- `P0001` statt `restrict_violation` (SQLSTATE 23001).
--
-- Der Treiberadapter von Prisma 7 bildet 23001 auf „Fremdschlüssel
-- verletzt" ab (P2003) und verwirft die Meldung der Datenbank. Die Sperre
-- hielt weiter — aber aus „Vertragsfassung … ist gesperrt" wurde
-- „Foreign key constraint violated on the (not available)", und über die
-- Anwendung hätte die Antwort „Der Datensatz ist noch mit anderen Objekten
-- verknüpft" gelautet. Gefunden von `vertraege-integritaet.test.ts`
-- („Unveränderlichkeit in der Datenbank"), die die Meldung prüft.
--
-- `P0001` (raise_exception) benutzen die übrigen 27 Schutztrigger dieses
-- Schemas; der Adapter reicht Code und Meldung dort unverändert durch.
--
-- Die drei Funktionen sind **wörtlich** die aus
-- `20260923100000_vertragsintegritaet`, geändert ist allein der Fehlercode.
-- Die Trigger bleiben bestehen: Sie rufen die Funktionen über den Namen auf.
-- Keine Tabelle, keine Spalte, keine Daten — die alte Programmfassung läuft
-- unverändert weiter.

CREATE OR REPLACE FUNCTION "vertragsfassung_unveraenderlich"()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  frei_aendbar CONSTANT TEXT[] := ARRAY['status', 'effectiveUntil', 'acceptedAt', 'acceptedRequestId', 'updatedAt'];
BEGIN
  IF NOT "vertragsfassung_ist_gesperrt"(OLD."id") THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - frei_aendbar) IS DISTINCT FROM (to_jsonb(OLD) - frei_aendbar) THEN
    RAISE EXCEPTION 'Vertragsfassung % ist gesperrt: Konditionen einer geltenden, abgelösten oder angenommenen Fassung ändern sich nur durch eine neue Fassung.', OLD."id"
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE')
           OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'Vertragsfassung %: Übergang % → % ist nicht zulässig.', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW."effectiveUntil" IS DISTINCT FROM OLD."effectiveUntil"
     AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Vertragsfassung %: das Ende der Gültigkeit wird nur beim Ablösen gesetzt.', OLD."id"
      USING ERRCODE = 'P0001';
  END IF;

  IF (NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
      OR NEW."acceptedRequestId" IS DISTINCT FROM OLD."acceptedRequestId")
     AND NOT (OLD."acceptedAt" IS NULL AND OLD."status" = 'DRAFT') THEN
    RAISE EXCEPTION 'Vertragsfassung %: die Annahme lässt sich nicht ändern.', OLD."id"
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "vertragsleistung_unveraenderlich"()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  fassung TEXT;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  fassung := CASE WHEN TG_OP = 'DELETE' THEN OLD."contractVersionId" ELSE NEW."contractVersionId" END;
  IF "vertragsfassung_ist_gesperrt"(fassung)
     OR (TG_OP = 'UPDATE' AND OLD."contractVersionId" <> NEW."contractVersionId"
         AND "vertragsfassung_ist_gesperrt"(OLD."contractVersionId")) THEN
    RAISE EXCEPTION 'Der Leistungsumfang der Vertragsfassung % ist gesperrt.', fassung
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION "einsatzplan_unveraenderlich"()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  fassung TEXT;
  nur_marke CONSTANT TEXT[] := ARRAY['generatedUntil', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  -- Eine neue Serie ohne ausdrückliche Linie ist ihre eigene. Steht hier und
  -- nicht als Spaltenvorgabe, weil Prisma die Kennung selbst erzeugt
  -- (`@default(cuid())`) und eine Datenbankvorgabe daneben als Abweichung
  -- vom Schema gälte. Der Fall tritt ein, wenn ein Client mit älterem
  -- Schemastand schreibt.
  IF TG_OP = 'INSERT' AND NEW."seriesKey" IS NULL THEN
    NEW."seriesKey" := NEW."id";
  END IF;
  SELECT cs."contractVersionId" INTO fassung
    FROM "contract_services" cs
   WHERE cs."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."contractServiceId" ELSE NEW."contractServiceId" END;

  IF NOT "vertragsfassung_ist_gesperrt"(fassung) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - nur_marke) = (to_jsonb(OLD) - nur_marke) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Der Einsatzplan der Vertragsfassung % ist gesperrt. Die Frequenz ändert sich nur durch eine neue Fassung; einen einzelnen Termin verschiebt eine Ausnahme.', fassung
    USING ERRCODE = 'P0001';
END;
$$;
