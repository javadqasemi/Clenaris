-- Handlungsaufrufe (Call to Action)
--
-- Jede Schaltfläche, die auf der öffentlichen Website zu einer Handlung
-- auffordert, wird ab hier aus der Datenbank gespeist statt im Quelltext zu
-- stehen. Das ist der Zweck der Tabelle: Text, Farbe, Symbol, Ziel, Platz und
-- Laufzeit sollen ohne Auslieferung änderbar sein.

CREATE TYPE "CtaSlot" AS ENUM (
  'HEADER',
  'HERO_PRIMARY',
  'HERO_SECONDARY',
  'SECTION_BANNER',
  'FOOTER',
  'MOBILE_BAR'
);

CREATE TYPE "CtaStyle" AS ENUM (
  'PRIMARY',
  'SECONDARY',
  'OUTLINE',
  'GHOST',
  'ACCENT',
  'SUCCESS',
  'CUSTOM'
);

CREATE TABLE "calls_to_action" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "key"            TEXT NOT NULL,
  "label"          TEXT NOT NULL,
  "note"           TEXT,
  "href"           TEXT NOT NULL,
  "newTab"         BOOLEAN NOT NULL DEFAULT false,
  "icon"           TEXT,
  "slot"           "CtaSlot" NOT NULL,
  "style"          "CtaStyle" NOT NULL DEFAULT 'PRIMARY',
  "bgColor"        TEXT,
  "fgColor"        TEXT,
  "pages"          TEXT[] DEFAULT ARRAY[]::TEXT[],
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "position"       INTEGER NOT NULL DEFAULT 0,
  "publishFrom"    TIMESTAMPTZ(6),
  "publishUntil"   TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"      TIMESTAMPTZ(6),

  CONSTRAINT "calls_to_action_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calls_to_action_organizationId_key_key"
  ON "calls_to_action" ("organizationId", "key");

-- Die öffentliche Website fragt immer nach Platz und Aktivität; genau diese
-- Kombination deckt der Index ab.
CREATE INDEX "calls_to_action_organizationId_slot_active_idx"
  ON "calls_to_action" ("organizationId", "slot", "active");

ALTER TABLE "calls_to_action"
  ADD CONSTRAINT "calls_to_action_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
