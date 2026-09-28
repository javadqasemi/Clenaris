-- Lohnabrechnung — technischer Ausbau (Wave 9, 2026-09-23).
--
-- Neu: versionierte Beitragssätze mit Gültigkeitszeitraum und Prüfstand,
-- Lohnpositionen, Abrechnungszeilen, Quellensteuerprofil und -tarif,
-- Aufstellung für den Lohnausweis, lohnbezogene Vereinbarungen je Person.
--
-- Rein additiv. Die Tabelle `payroll_settings` bleibt stehen und wird nicht
-- mehr beschrieben; ihre Werte wandern unten als **ungeprüfte** Versionen nach
-- `payroll_rates`. Nicht gelöscht, weil ältere Abrechnungen in `breakdown`
-- auf dieselben Werte verweisen und eine Löschung nichts gewönne.

-- CreateEnum
CREATE TYPE "PayrollRateCode" AS ENUM ('AHV_IV_EO', 'ALV', 'ALV_SOLIDARITY', 'UVG_NBU', 'UVG_BU', 'KTG', 'FAK', 'VK', 'BVG');

-- CreateEnum
CREATE TYPE "PayrollVerification" AS ENUM ('UNGEPRUEFT', 'GEPRUEFT');

-- CreateEnum
CREATE TYPE "ThirteenthSalaryMode" AS ENUM ('NONE', 'ANNUAL', 'PRO_RATA', 'MONTHLY');

-- CreateEnum
CREATE TYPE "PayrollItemType" AS ENUM ('OVERTIME', 'ALLOWANCE', 'FAMILY_ALLOWANCE', 'EXPENSE', 'CORRECTION', 'NET_CORRECTION', 'DEDUCTION', 'WITHHOLDING_TAX_MANUAL');

-- CreateEnum
CREATE TYPE "PayslipLineType" AS ENUM ('BASE', 'UNPAID_LEAVE', 'OVERTIME', 'ALLOWANCE', 'FAMILY_ALLOWANCE', 'VACATION_PAY', 'HOLIDAY_PAY', 'THIRTEENTH', 'CORRECTION', 'EXPENSE', 'NET_CORRECTION', 'AHV_IV_EO', 'ALV', 'BVG', 'UVG_NBU', 'KTG', 'WITHHOLDING_TAX', 'DEDUCTION', 'EMPLOYER');

-- CreateEnum
CREATE TYPE "PayslipLineKind" AS ENUM ('EARNING', 'PAYMENT', 'DEDUCTION', 'EMPLOYER');

-- CreateEnum
CREATE TYPE "SalaryCertificateStatus" AS ENUM ('DRAFT', 'FINAL');

-- AlterEnum
ALTER TYPE "FileScope" ADD VALUE 'PAYROLL';

-- AlterTable
ALTER TABLE "payslips" ADD COLUMN     "employerContributions" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "expenses" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "pdfChecksum" TEXT,
ADD COLUMN     "pdfFileId" TEXT,
ADD COLUMN     "rateVersionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewResolvedAt" TIMESTAMPTZ(6),
ADD COLUMN     "reviewResolvedById" TEXT,
ADD COLUMN     "unverifiedRates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "withholdingTax" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payroll_rates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" "PayrollRateCode" NOT NULL,
    "validFrom" DATE NOT NULL,
    "validUntil" DATE,
    "employeePct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "employerPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "thresholdMin" DECIMAL(12,2),
    "thresholdMax" DECIMAL(12,2),
    "parameters" JSONB,
    "source" TEXT NOT NULL,
    "reference" TEXT,
    "verification" "PayrollVerification" NOT NULL DEFAULT 'UNGEPRUEFT',
    "verifiedAt" TIMESTAMPTZ(6),
    "verifiedById" TEXT,
    "verificationNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payroll_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_payroll_profiles" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "thirteenthMode" "ThirteenthSalaryMode" NOT NULL DEFAULT 'NONE',
    "thirteenthPayoutMonth" INTEGER NOT NULL DEFAULT 12,
    "vacationPayInWage" BOOLEAN NOT NULL DEFAULT false,
    "holidayPayPct" DECIMAL(6,3),
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_payroll_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "type" "PayrollItemType" NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(10,2),
    "rate" DECIMAL(12,2),
    "surchargePct" DECIMAL(6,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "correctsPayslipId" TEXT,
    "payslipId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_lines" (
    "id" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "PayslipLineType" NOT NULL,
    "kind" "PayslipLineKind" NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(10,2),
    "rate" DECIMAL(12,4),
    "amount" DECIMAL(12,2) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "certificateField" TEXT,
    "sourceItemId" TEXT,

    CONSTRAINT "payslip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withholding_tax_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validUntil" DATE,
    "canton" TEXT NOT NULL,
    "tariffCode" TEXT NOT NULL,
    "churchTax" BOOLEAN NOT NULL DEFAULT false,
    "children" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "withholding_tax_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withholding_tax_rates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "canton" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "tariffCode" TEXT NOT NULL,
    "incomeFrom" DECIMAL(12,2) NOT NULL,
    "incomeTo" DECIMAL(12,2),
    "ratePct" DECIMAL(7,4) NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT,
    "verification" "PayrollVerification" NOT NULL DEFAULT 'UNGEPRUEFT',
    "importBatch" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withholding_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_certificates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "SalaryCertificateStatus" NOT NULL DEFAULT 'DRAFT',
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "fields" JSONB NOT NULL,
    "payslipIds" TEXT[],
    "pdfFileId" TEXT,
    "pdfChecksum" TEXT,
    "finalizedAt" TIMESTAMPTZ(6),
    "finalizedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "salary_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_rates_organizationId_code_validFrom_idx" ON "payroll_rates"("organizationId", "code", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "employee_payroll_profiles_employeeId_key" ON "employee_payroll_profiles"("employeeId");

-- CreateIndex
CREATE INDEX "payroll_items_organizationId_year_month_idx" ON "payroll_items"("organizationId", "year", "month");

-- CreateIndex
CREATE INDEX "payroll_items_employeeId_year_month_idx" ON "payroll_items"("employeeId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "payslip_lines_payslipId_position_key" ON "payslip_lines"("payslipId", "position");

-- CreateIndex
CREATE INDEX "withholding_tax_profiles_employeeId_validFrom_idx" ON "withholding_tax_profiles"("employeeId", "validFrom");

-- CreateIndex
CREATE INDEX "withholding_tax_rates_organizationId_canton_year_tariffCode_idx" ON "withholding_tax_rates"("organizationId", "canton", "year", "tariffCode");

-- CreateIndex
CREATE UNIQUE INDEX "withholding_tax_rates_organizationId_canton_year_tariffCode_key" ON "withholding_tax_rates"("organizationId", "canton", "year", "tariffCode", "incomeFrom");

-- CreateIndex
CREATE UNIQUE INDEX "salary_certificates_employeeId_year_version_key" ON "salary_certificates"("employeeId", "year", "version");

-- AddForeignKey
ALTER TABLE "payroll_rates" ADD CONSTRAINT "payroll_rates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_payroll_profiles" ADD CONSTRAINT "employee_payroll_profiles_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_tax_profiles" ADD CONSTRAINT "withholding_tax_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_tax_profiles" ADD CONSTRAINT "withholding_tax_profiles_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withholding_tax_rates" ADD CONSTRAINT "withholding_tax_rates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_certificates" ADD CONSTRAINT "salary_certificates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_certificates" ADD CONSTRAINT "salary_certificates_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
--  Von Hand ergänzt — was das Schema nicht ausdrücken kann.
--  `prisma validate` bemerkt es nicht; ein späteres `migrate dev` würde
--  anbieten, es zu entfernen. Nicht annehmen.
-- ===========================================================================

-- Wertebereiche. Ein Monat 13 oder ein Satz von 250 % ist kein Grenzfall,
-- sondern ein Eingabefehler, den die Datenbank nicht speichern soll.
ALTER TABLE "payroll_rates"
  ADD CONSTRAINT "payroll_rates_zeitraum" CHECK ("validUntil" IS NULL OR "validUntil" >= "validFrom"),
  ADD CONSTRAINT "payroll_rates_prozent" CHECK ("employeePct" BETWEEN 0 AND 100 AND "employerPct" BETWEEN 0 AND 100);
ALTER TABLE "payroll_items"
  ADD CONSTRAINT "payroll_items_monat" CHECK ("month" BETWEEN 1 AND 12);
ALTER TABLE "employee_payroll_profiles"
  ADD CONSTRAINT "employee_payroll_profiles_monat" CHECK ("thirteenthPayoutMonth" BETWEEN 1 AND 12);
ALTER TABLE "withholding_tax_profiles"
  ADD CONSTRAINT "withholding_tax_profiles_zeitraum" CHECK ("validUntil" IS NULL OR "validUntil" >= "validFrom"),
  ADD CONSTRAINT "withholding_tax_profiles_kinder" CHECK ("children" BETWEEN 0 AND 20);
ALTER TABLE "withholding_tax_rates"
  ADD CONSTRAINT "withholding_tax_rates_satz" CHECK ("ratePct" BETWEEN 0 AND 100),
  ADD CONSTRAINT "withholding_tax_rates_stufe" CHECK ("incomeTo" IS NULL OR "incomeTo" > "incomeFrom");

-- Keine zwei gültigen Versionen desselben Satzes am selben Tag. Ohne diese
-- Bedingung hinge die Abrechnung davon ab, welche Zeile die Datenbank zuerst
-- liefert. `code` direkt: btree_gist kennt `=` auf Aufzählungstypen; eine
-- Umwandlung nach `text` ginge nicht, sie ist nicht IMMUTABLE und damit in
-- einem Index unzulässig (so beim ersten Anwenden gescheitert).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "payroll_rates" ADD CONSTRAINT "payroll_rates_ueberlappungsfrei"
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "code" WITH =,
    daterange("validFrom", "validUntil", '[]') WITH &&
  );

-- Je Person höchstens ein gültiges Quellensteuerprofil an einem Tag.
ALTER TABLE "withholding_tax_profiles" ADD CONSTRAINT "withholding_tax_profiles_ueberlappungsfrei"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    daterange("validFrom", "validUntil", '[]') WITH &&
  );

-- Je Person, Jahr und Monat höchstens eine offene Quellensteuer von Hand —
-- sonst wäre unklar, welche gilt.
CREATE UNIQUE INDEX "payroll_items_qst_manuell_einmal"
  ON "payroll_items" ("employeeId", "year", "month")
  WHERE "type" = 'WITHHOLDING_TAX_MANUAL' AND "deletedAt" IS NULL;

-- Übernahme der bisherigen Jahressätze. **Ungeprüft**, auch wo die Zeile
-- schon einmal bearbeitet wurde: Die alte Tabelle unterschied „bearbeitet"
-- nicht von „fachlich bestätigt" — das war genau die Schwäche. Der
-- Arbeitgeberanteil AHV/IV/EO und ALV entspricht von Gesetzes wegen dem
-- Arbeitnehmeranteil; übernommen wird er trotzdem als ungeprüfte Vorbelegung.
INSERT INTO "payroll_rates" ("id", "organizationId", "code", "validFrom", "validUntil",
  "employeePct", "employerPct", "thresholdMin", "thresholdMax", "parameters", "source", "updatedAt")
SELECT 'pr_' || md5(s."id" || c.code), s."organizationId", c.code::"PayrollRateCode",
  make_date(s."year", 1, 1), make_date(s."year", 12, 31),
  c.an, c.ag, c.tmin, c.tmax, c.params,
  'Übernommen aus den Jahressätzen ' || s."year" || ' (ungeprüft)', CURRENT_TIMESTAMP
FROM "payroll_settings" s
CROSS JOIN LATERAL (VALUES
  ('AHV_IV_EO', s."ahvIvEo", s."ahvIvEo", NULL::numeric, NULL::numeric, NULL::jsonb),
  ('ALV', s."alv", s."alv", NULL, s."alvGrenzeJahr", NULL),
  ('ALV_SOLIDARITY', s."alvUeberGrenze", s."alvUeberGrenze", s."alvGrenzeJahr", NULL, NULL),
  ('UVG_NBU', s."uvgNbu", 0, NULL, NULL, NULL),
  ('KTG', s."ktg", 0, NULL, NULL, NULL),
  ('BVG', s."bvgAnteilArbeitnehmer", 100 - s."bvgAnteilArbeitnehmer", NULL, NULL,
    jsonb_build_object(
      'eintrittsschwelle', s."bvgEintrittsschwelle",
      'koordinationsabzug', s."bvgKoordinationsabzug",
      'mindestKoordiniert', s."bvgMindestKoordiniert",
      'obergrenze', s."bvgObergrenze",
      'baender', s."bvgSaetze"))
) AS c(code, an, ag, tmin, tmax, params);

-- ---------------------------------------------------------------------------
--  Unveränderlichkeit nach dem Veröffentlichen
-- ---------------------------------------------------------------------------
--
-- Der Dienst schreibt nur unveröffentlichte Abrechnungen (`published: false`
-- in der Bedingung). Diese Trigger sind die zweite Linie: Auch ein direkter
-- Zugriff, ein Skript oder ein künftiger Codepfad ändert eine
-- veröffentlichte Abrechnung nicht. Kaskaden aus dem Löschen einer
-- Organisation (Datenbereinigung) sind erlaubt (`pg_trigger_depth() > 1`).

CREATE OR REPLACE FUNCTION "lohnabrechnung_unveraenderlich"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."published" AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Lohnabrechnung % ist veröffentlicht und lässt sich nicht löschen.', OLD."id";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."published" THEN
    RAISE EXCEPTION 'Lohnabrechnung % ist veröffentlicht und unveränderlich — Korrekturen laufen über einen Folgemonat.', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payslips_unveraenderlich"
  BEFORE UPDATE OR DELETE ON "payslips"
  FOR EACH ROW EXECUTE FUNCTION "lohnabrechnung_unveraenderlich"();

CREATE OR REPLACE FUNCTION "lohnzeile_unveraenderlich"() RETURNS trigger AS $$
DECLARE
  abrechnung TEXT := COALESCE(NEW."payslipId", OLD."payslipId");
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF EXISTS (SELECT 1 FROM "payslips" p WHERE p."id" = abrechnung AND p."published") THEN
    RAISE EXCEPTION 'Zeilen der veröffentlichten Lohnabrechnung % sind unveränderlich.', abrechnung;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payslip_lines_unveraenderlich"
  BEFORE INSERT OR UPDATE OR DELETE ON "payslip_lines"
  FOR EACH ROW EXECUTE FUNCTION "lohnzeile_unveraenderlich"();

-- Eine Lohnposition, die in einer veröffentlichten Abrechnung steht, ist Beleg.
CREATE OR REPLACE FUNCTION "lohnposition_unveraenderlich"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF OLD."payslipId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "payslips" p WHERE p."id" = OLD."payslipId" AND p."published") THEN
    RAISE EXCEPTION 'Lohnposition % steht in einer veröffentlichten Abrechnung und ist unveränderlich.', OLD."id";
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payroll_items_unveraenderlich"
  BEFORE UPDATE OR DELETE ON "payroll_items"
  FOR EACH ROW EXECUTE FUNCTION "lohnposition_unveraenderlich"();

-- Eine Satzversion, mit der eine veröffentlichte Abrechnung gerechnet wurde,
-- behält ihre Werte. Prüfstand und Vermerk dürfen sich ändern — die
-- Bestätigung ändert keinen Betrag. Das Ende der Gültigkeit prüft der Dienst.
CREATE OR REPLACE FUNCTION "beitragssatz_unveraenderlich"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF EXISTS (SELECT 1 FROM "payslips" p WHERE p."published" AND OLD."id" = ANY(p."rateVersionIds")) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Satzversion % wurde für eine veröffentlichte Abrechnung benutzt und bleibt bestehen.', OLD."id";
    END IF;
    IF NEW."code" IS DISTINCT FROM OLD."code"
       OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom"
       OR NEW."employeePct" IS DISTINCT FROM OLD."employeePct"
       OR NEW."employerPct" IS DISTINCT FROM OLD."employerPct"
       OR NEW."thresholdMin" IS DISTINCT FROM OLD."thresholdMin"
       OR NEW."thresholdMax" IS DISTINCT FROM OLD."thresholdMax"
       OR NEW."parameters" IS DISTINCT FROM OLD."parameters" THEN
      RAISE EXCEPTION 'Satzversion % wurde für eine veröffentlichte Abrechnung benutzt — eine neue Version mit späterem Beginn ist der Weg.', OLD."id";
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payroll_rates_unveraenderlich"
  BEFORE UPDATE OR DELETE ON "payroll_rates"
  FOR EACH ROW EXECUTE FUNCTION "beitragssatz_unveraenderlich"();

-- Ein abgeschlossener Lohnausweis ist Beleg; eine Korrektur ist eine neue Version.
CREATE OR REPLACE FUNCTION "lohnausweis_unveraenderlich"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF OLD."status" = 'FINAL' THEN
    RAISE EXCEPTION 'Lohnausweis % ist abgeschlossen — eine Korrektur ist eine neue Version.', OLD."id";
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "salary_certificates_unveraenderlich"
  BEFORE UPDATE OR DELETE ON "salary_certificates"
  FOR EACH ROW EXECUTE FUNCTION "lohnausweis_unveraenderlich"();
