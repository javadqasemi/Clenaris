-- Vertragsintegrität (Release-Blocker RB-003, RB-004, RB-006, RB-007, RB-008).
--
-- Entstanden über `prisma migrate diff` gegen die Entwicklungsdatenbank und
-- von Hand ergänzt. Additiv bis auf zwei Dinge, beide ohne Datenverlust:
--
--   • `DROP INDEX "jobs_serviceScheduleId_scheduleDate_key"` — der alte
--     eindeutige Index wird durch einen partiellen ersetzt (unten begründet)
--     und bleibt als gewöhnlicher Suchindex bestehen.
--   • Nachträge (`UPDATE`) für die neuen Spalten, damit Bestand und neue
--     Regel zusammenpassen.
--
-- Nicht übernommen: der `DROP DEFAULT` auf `payroll_settings`/`payslips`, den
-- Prisma bei jedem Diff vorschlägt — dieselbe Entscheidung wie in den
-- vorangegangenen Migrationen.

-- ---------------------------------------------------------------------------
--  1. Fachliche Serienidentität
-- ---------------------------------------------------------------------------

ALTER TABLE "service_schedules" ADD COLUMN "seriesKey" TEXT;
-- Bestand: Jede bestehende Serie ist ihre eigene Linie. Die Kopien früherer
-- Fassungswechsel lassen sich nicht sicher ihrer Vorlage zuordnen — ein
-- Zuordnen nach Bezeichnung könnte zwei verschiedene Leistungen gleichen
-- Namens verschmelzen. Neue Kopien übernehmen die Kennung ab jetzt.
UPDATE "service_schedules" SET "seriesKey" = "id" WHERE "seriesKey" IS NULL;
ALTER TABLE "service_schedules" ALTER COLUMN "seriesKey" SET NOT NULL;
CREATE INDEX "service_schedules_seriesKey_idx" ON "service_schedules"("seriesKey");

ALTER TABLE "jobs" ADD COLUMN "seriesKey" TEXT;
UPDATE "jobs" j
   SET "seriesKey" = s."seriesKey"
  FROM "service_schedules" s
 WHERE j."serviceScheduleId" = s."id" AND j."seriesKey" IS NULL;

DROP INDEX "jobs_serviceScheduleId_scheduleDate_key";
CREATE INDEX "jobs_serviceScheduleId_scheduleDate_idx" ON "jobs"("serviceScheduleId", "scheduleDate");
CREATE INDEX "jobs_contractId_seriesKey_scheduleDate_idx" ON "jobs"("contractId", "seriesKey", "scheduleDate");

-- Die Doppelsperre des Planers — neu gefasst.
--
-- Zwei Fehler der alten Fassung `(serviceScheduleId, scheduleDate)`:
--
--  1. Die Kennung der Serie wechselte mit jeder neuen Vertragsfassung, weil
--     die Fassung ihre Pläne kopiert. Derselbe Termin hatte unter Fassung 1
--     und Fassung 2 zwei Schlüssel — der Doppeleinsatz nach einem
--     Fassungswechsel.
--  2. Ein **abgesagter** Einsatz hielt den Schlüssel fest. Nach einer Pause
--     oder einer zurückgenommenen Ausnahme liess sich derselbe Termin nie
--     wieder anlegen.
--
-- Deshalb die fachliche Serie statt der Zeile, und nur über Einsätze, die
-- gelten. Ein Einsatz ohne Serie (`seriesKey IS NULL`) ist nicht betroffen.
CREATE UNIQUE INDEX "jobs_serientermin_einmal"
    ON "jobs" ("contractId", "seriesKey", "scheduleDate")
 WHERE "seriesKey" IS NOT NULL
   AND "status" <> 'CANCELLED'
   AND "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
--  2. Preisanpassung: Ausgangs- und Ergebnisfassung getrennt
-- ---------------------------------------------------------------------------

ALTER TABLE "contract_price_adjustments" ADD COLUMN "resultVersionId" TEXT;
ALTER TABLE "contract_price_adjustments"
  ADD CONSTRAINT "contract_price_adjustments_resultVersionId_fkey"
  FOREIGN KEY ("resultVersionId") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bestand: Bis heute überschrieb das Anwenden `contractVersionId` mit der
-- entstandenen Fassung. Für angewandte Anpassungen steht dort also das
-- Ergebnis; die Ausgangsfassung ist die mit der vorangehenden Nummer desselben
-- Vertrags. Das ist eine Rekonstruktion, und sie ist eindeutig: Das Anwenden
-- legte immer genau die nächste Nummer an.
UPDATE "contract_price_adjustments" pa
   SET "resultVersionId" = pa."contractVersionId",
       "contractVersionId" = vorher."id"
  FROM "contract_versions" ergebnis
  JOIN "contract_versions" vorher
    ON vorher."contractId" = ergebnis."contractId"
   AND vorher."versionNumber" = ergebnis."versionNumber" - 1
 WHERE pa."status" = 'APPLIED'
   AND pa."resultVersionId" IS NULL
   AND ergebnis."id" = pa."contractVersionId";

-- ---------------------------------------------------------------------------
--  3. Abrechnungsperioden überlappen nie
-- ---------------------------------------------------------------------------

ALTER TABLE "invoices" ADD COLUMN "contractPeriodEnd" DATE;

-- Bestand: das Ende aus dem Zyklus der Fassung, unter der fakturiert wurde.
UPDATE "invoices" i
   SET "contractPeriodEnd" = (i."contractPeriodStart" + (
         CASE v."billingCycle"
           WHEN 'QUARTERLY'  THEN INTERVAL '3 months'
           WHEN 'SEMIANNUAL' THEN INTERVAL '6 months'
           WHEN 'ANNUAL'     THEN INTERVAL '12 months'
           ELSE INTERVAL '1 month'
         END))::date
  FROM "contract_versions" v
 WHERE i."contractVersionId" = v."id"
   AND i."contractPeriodStart" IS NOT NULL
   AND i."contractPeriodEnd" IS NULL;

-- `btree_gist` erlaubt `=` auf Text in einer GiST-Ausschlussbedingung. Die
-- Erweiterung gehört zum Lieferumfang von PostgreSQL (contrib) und ist bei
-- den üblichen Anbietern freigegeben.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Keine zwei gültigen Rechnungen eines Vertrags überlappen sich zeitlich.
--
-- Der Teilindex `invoices_vertragsperiode_einmal` über den Periodenbeginn
-- bleibt bestehen; er verhinderte die doppelte Abrechnung **derselben**
-- Periode. Was er nicht sah, war der Zykluswechsel: „Januar" und „1. Quartal"
-- beginnen am selben Tag, „Februar" aber nicht — Februar und März liessen sich
-- zusätzlich zum Quartal abrechnen. Eine Ausschlussbedingung über den
-- Zeitraum erfasst jede Überlappung, unabhängig davon, wie der Zyklus heisst.
-- Stornierte und gelöschte Belege geben ihren Zeitraum frei.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_vertragsperiode_ueberlappungsfrei"
  EXCLUDE USING gist (
    "contractId" WITH =,
    daterange("contractPeriodStart", "contractPeriodEnd", '[)') WITH &&
  )
  WHERE ("contractId" IS NOT NULL
     AND "contractPeriodStart" IS NOT NULL
     AND "contractPeriodEnd" IS NOT NULL
     AND "status" <> 'CANCELLED'
     AND "deletedAt" IS NULL);

-- ---------------------------------------------------------------------------
--  4. Unveränderlichkeit in der Datenbank
-- ---------------------------------------------------------------------------
--
-- Bis hierher stand die Unveränderlichkeit einer geltenden oder angenommenen
-- Fassung nur im Dienst. Der Teilindex `contract_versions_eine_aktive`
-- beweist Eindeutigkeit, nicht Unveränderlichkeit — ein neuer Codepfad, ein
-- `updateMany` oder ein Handgriff in SQL hätte eine unterschriebene Fassung
-- still ändern können. Das Audit vom 2026-09-23 hat zwei solche Pfade im
-- eigenen Code gefunden (`activateContract` überschrieb `effectiveFrom`, die
-- Pläne einer signierten Fassung liessen sich ändern).
--
-- **Gesperrt** ist eine Fassung, sobald eine der drei Bedingungen gilt:
-- sie ist nicht mehr Entwurf, sie wurde angenommen, oder ein Annahmevorgang
-- läuft. Erlaubt bleiben genau die Übergänge des Lebenslaufs:
--
--   • DRAFT → ACTIVE (Inkraftsetzung), ACTIVE → SUPERSEDED (Ablösung),
--   • `effectiveUntil` beim Ablösen,
--   • `acceptedAt`/`acceptedRequestId` einmal, auf einem Entwurf,
--   • `updatedAt`.
--
-- Löschungen werden **nicht** gesperrt: Die Datenbereinigung und das Löschen
-- einer Organisation laufen über Kaskaden, und ein Beleg-Vertrag wird im
-- Dienst ohnehin nie hart gelöscht. Diese Grenze ist bewusst gezogen und in
-- docs/VERTRAEGE.md beschrieben.

CREATE OR REPLACE FUNCTION "vertragsfassung_ist_gesperrt"(fassung_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "contract_versions" v
     WHERE v."id" = fassung_id
       AND (v."status" <> 'DRAFT' OR v."acceptedAt" IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM "signature_requests" r
     WHERE r."contractVersionId" = fassung_id
       AND r."status" IN ('DRAFT', 'PENDING', 'FINALIZING')
  );
$$;

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
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE')
           OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'Vertragsfassung %: Übergang % → % ist nicht zulässig.', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."effectiveUntil" IS DISTINCT FROM OLD."effectiveUntil"
     AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Vertragsfassung %: das Ende der Gültigkeit wird nur beim Ablösen gesetzt.', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
      OR NEW."acceptedRequestId" IS DISTINCT FROM OLD."acceptedRequestId")
     AND NOT (OLD."acceptedAt" IS NULL AND OLD."status" = 'DRAFT') THEN
    RAISE EXCEPTION 'Vertragsfassung %: die Annahme lässt sich nicht ändern.', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "contract_versions_unveraenderlich"
  BEFORE UPDATE ON "contract_versions"
  FOR EACH ROW EXECUTE FUNCTION "vertragsfassung_unveraenderlich"();

-- Leistungen: an einer gesperrten Fassung weder anlegen, ändern noch
-- entfernen. Ausnahme: eine Löschung als Folge einer Kaskade
-- (`pg_trigger_depth() > 1`) — siehe oben, Datenbereinigung.
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
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "contract_services_unveraenderlich"
  BEFORE INSERT OR UPDATE OR DELETE ON "contract_services"
  FOR EACH ROW EXECUTE FUNCTION "vertragsleistung_unveraenderlich"();

-- Einsatzpläne: dieselbe Regel. Die eine Ausnahme ist die Fortschrittsmarke
-- des Planers (`generatedUntil`) — kein Teil der Vereinbarung.
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
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "service_schedules_unveraenderlich"
  BEFORE INSERT OR UPDATE OR DELETE ON "service_schedules"
  FOR EACH ROW EXECUTE FUNCTION "einsatzplan_unveraenderlich"();
