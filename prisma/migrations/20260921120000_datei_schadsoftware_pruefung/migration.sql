-- ===========================================================================
--  Schadsoftwareprüfung für Dateien — Zustände, Herkunft, Altbestand
-- ===========================================================================
--
-- Additiv: zwei Aufzählungstypen, elf Spalten, zwei Indizes. Kein DROP, keine
-- Spaltenänderung, kein Datenverlust. Die vorige Programmfassung läuft mit
-- diesem Schema unverändert weiter — sie kennt die Spalten nicht und schreibt
-- sie nicht.
--
-- ---------------------------------------------------------------------------
--  Der handgeschriebene Teil und warum er nötig ist
-- ---------------------------------------------------------------------------
--
-- `ADD COLUMN ... DEFAULT` füllt bestehende Zeilen mit dem Vorgabewert. Für
-- `scanStatus` ist das richtig — `PENDING` heisst „nie geprüft", und das
-- stimmt für den Altbestand.
--
-- Für `provenance` wäre es **falsch**. Die Vorgabe ist `USER_UPLOAD`, weil das
-- die misstrauischste Einstufung für *neue* Zeilen ist. Auf den Altbestand
-- angewandt behauptete sie etwas, das niemand geprüft hat: dass diese Dateien
-- den heutigen Upload-Weg durchlaufen haben. Manche haben das, andere sind
-- servererzeugte PDF, und bei wieder anderen weiss es niemand mehr.
--
-- Deshalb der `UPDATE` unten: Jede Zeile, die zum Zeitpunkt dieser Migration
-- existiert, ist per Definition Altbestand und wird als solcher markiert.
-- Neue Zeilen entstehen erst nach dem Ende dieser Transaktion und bekommen
-- die Vorgabe.
--
-- `LEGACY_UNSCANNED` ist damit eine ehrliche Aussage: Wir wissen nicht, was in
-- diesen Dateien steht, und wir sagen es.
--
-- ---------------------------------------------------------------------------
--  Was das für den Betrieb bedeutet
-- ---------------------------------------------------------------------------
--
-- Der Altbestand ist nach dieser Migration **nicht auslieferbar**, weil
-- `scanStatus = PENDING` ist. Das ist gewollt und der Grund, warum
-- `scripts/scan-backfill.ts` zu dieser Migration gehört: Er liest die Bytes
-- erneut, lässt sie prüfen und setzt den Zustand. Erst danach sind die Dateien
-- wieder erreichbar.
--
-- Für den Übergang gibt es `CLENARIS_LEGACY_FILES=allow`. Die Einstellung ist
-- ausdrücklich, befristet gedacht und protokolliert jeden Zugriff. Sie steht
-- in `docs/MALWARE_PROTECTION.md` mit der Begründung, warum sie nicht die
-- Vorgabe ist.

-- CreateEnum
CREATE TYPE "FileProvenance" AS ENUM ('USER_UPLOAD', 'SYSTEM_GENERATED', 'TRUSTED_IMPORT', 'LEGACY_UNSCANNED');

-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('PENDING', 'SCANNING', 'CLEAN', 'INFECTED', 'ERROR', 'QUARANTINED');

-- AlterTable
ALTER TABLE "file_assets" ADD COLUMN     "detectedMimeType" TEXT,
ADD COLUMN     "detectionName" TEXT,
ADD COLUMN     "lastScanErrorCode" TEXT,
ADD COLUMN     "provenance" "FileProvenance" NOT NULL DEFAULT 'USER_UPLOAD',
ADD COLUMN     "quarantinedAt" TIMESTAMPTZ(6),
ADD COLUMN     "scanAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scanStartedAt" TIMESTAMPTZ(6),
ADD COLUMN     "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "scannedAt" TIMESTAMPTZ(6),
ADD COLUMN     "scanner" TEXT,
ADD COLUMN     "scannerVersion" TEXT;

-- ---------------------------------------------------------------------------
--  Altbestand markieren — von Hand ergänzt, siehe Kopfkommentar
-- ---------------------------------------------------------------------------
--
-- Kein `WHERE`: Innerhalb dieser Transaktion gibt es keine neueren Zeilen.
-- Ein `WHERE "createdAt" < now()` sähe sorgfältiger aus und wäre es nicht —
-- `now()` ist in PostgreSQL der Transaktionsbeginn, die Bedingung also
-- immer wahr, und sie verstellte den Blick darauf, warum das hier sicher ist.
UPDATE "file_assets" SET "provenance" = 'LEGACY_UNSCANNED';

-- CreateIndex
CREATE INDEX "file_assets_organizationId_scanStatus_idx" ON "file_assets"("organizationId", "scanStatus");

-- CreateIndex
CREATE INDEX "file_assets_scanStatus_scanAttempts_idx" ON "file_assets"("scanStatus", "scanAttempts");
