-- Navigation und Rechtstexte
--
-- Beides stand bisher im Quelltext. Ein Menüpunkt umzubenennen oder eine
-- Datenschutzerklärung anzupassen verlangte damit eine Auslieferung — bei
-- Rechtstexten ist das besonders unglücklich, weil sie sich ändern, wenn sich
-- Gesetze ändern, und nicht, wenn gerade jemand deployt.

CREATE TYPE "NavLocation" AS ENUM (
  'HEADER',
  'HEADER_PANEL',
  'FOOTER_SERVICES',
  'FOOTER_COMPANY',
  'FOOTER_LEGAL'
);

CREATE TABLE "navigation_items" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "location"       "NavLocation" NOT NULL,
  "label"          TEXT NOT NULL,
  "href"           TEXT NOT NULL,
  "description"    TEXT,
  "icon"           TEXT,
  "newTab"         BOOLEAN NOT NULL DEFAULT false,
  "parentId"       TEXT,
  "position"       INTEGER NOT NULL DEFAULT 0,
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "navigation_items_pkey" PRIMARY KEY ("id")
);

-- Die Website fragt immer nach Ort und Aktivität.
CREATE INDEX "navigation_items_organizationId_location_active_idx"
  ON "navigation_items" ("organizationId", "location", "active");

ALTER TABLE "navigation_items"
  ADD CONSTRAINT "navigation_items_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Ein gelöschter Übergeordneter nimmt seine Unterpunkte mit: ein Menüpunkt
-- ohne Elternteil im Aufklappbereich wäre nirgends erreichbar.
ALTER TABLE "navigation_items"
  ADD CONSTRAINT "navigation_items_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "navigation_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "legal_documents" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "slug"           TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  "version"        INTEGER NOT NULL DEFAULT 1,
  "effectiveFrom"  DATE NOT NULL DEFAULT CURRENT_DATE,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "legal_documents_organizationId_slug_key"
  ON "legal_documents" ("organizationId", "slug");

ALTER TABLE "legal_documents"
  ADD CONSTRAINT "legal_documents_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
