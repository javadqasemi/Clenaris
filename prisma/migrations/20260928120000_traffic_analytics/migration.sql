-- Eigene Besuchsmessung (2026-09-28) — rein additiv: drei neue Aufzählungen,
-- eine neue Tabelle, zwei Indizes, ein Fremdschlüssel. Kein bestehendes
-- Objekt wird verändert. Erzeugt mit
-- `prisma migrate diff --from-schema-datamodel <vorher> --to-schema-datamodel prisma/schema.prisma`,
-- danach von Hand um die Prüfbedingungen am Ende ergänzt.

-- CreateEnum
CREATE TYPE "TrafficEventName" AS ENUM ('PAGE_VIEW', 'CONTACT_PHONE', 'CONTACT_EMAIL', 'CONTACT_FORM', 'BOOKING_START', 'BOOKING_COMPLETE', 'QUOTE_REQUEST', 'NEWSLETTER_SIGNUP');

-- CreateEnum
CREATE TYPE "TrafficDevice" AS ENUM ('MOBILE', 'TABLET', 'DESKTOP');

-- CreateEnum
CREATE TYPE "TrafficBrowser" AS ENUM ('CHROME', 'FIREFOX', 'SAFARI', 'EDGE', 'OTHER');

-- CreateTable
CREATE TABLE "traffic_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "day" DATE NOT NULL,
    "path" TEXT NOT NULL,
    "eventName" "TrafficEventName" NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "landing" BOOLEAN NOT NULL DEFAULT false,
    "referrerHost" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "device" "TrafficDevice" NOT NULL,
    "browser" "TrafficBrowser" NOT NULL,

    CONSTRAINT "traffic_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "traffic_events_organizationId_day_idx" ON "traffic_events"("organizationId", "day");

-- CreateIndex
CREATE INDEX "traffic_events_organizationId_eventName_day_idx" ON "traffic_events"("organizationId", "eventName", "day");

-- AddForeignKey
ALTER TABLE "traffic_events" ADD CONSTRAINT "traffic_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Von Hand: Prüfbedingungen, die das Schema nicht ausdrücken kann
-- ---------------------------------------------------------------------------
--
-- Die Tabelle wird von einem öffentlichen Endpunkt gefüllt. Die Bereinigung
-- (`src/lib/traffic/bereinigen.ts`) sorgt dafür, dass nur ein kurzer,
-- absoluter Pfad und ein Hash ankommen — aber eine Zusicherung, die nur in
-- einem Codepfad steht, umgeht der nächste (ein Skript, ein späterer zweiter
-- Schreibweg). Deshalb hält die Datenbank die zwei Eigenschaften selbst fest,
-- auf die sich die Datenschutzaussage stützt:
--
--  • `path` ist ein Pfad der eigenen Website: beginnt mit `/`, höchstens 300
--    Zeichen, und ohne `?` — eine Abfragezeichenfolge (und damit ein Token
--    darin) kann gar nicht gespeichert werden.
--  • `sessionHash` ist genau ein SHA-256-Wert in Hex — keine rohe
--    Sitzungskennung, die über Tage hinweg verknüpfbar wäre.
--
-- Prisma kennt Prüfbedingungen nicht und schlägt deshalb auch nicht vor, sie
-- zu verwerfen; ein späteres `migrate diff` lässt sie stehen.
ALTER TABLE "traffic_events"
  ADD CONSTRAINT "traffic_events_pfad_form"
  CHECK (left("path", 1) = '/' AND char_length("path") <= 300 AND position('?' in "path") = 0);

ALTER TABLE "traffic_events"
  ADD CONSTRAINT "traffic_events_sitzung_hash"
  CHECK ("sessionHash" ~ '^[0-9a-f]{64}$');
