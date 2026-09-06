-- Redaktionell pflegbare Website-Inhalte, Suchmaschinenangaben,
-- Auftrittskanäle und die Rolle SUPER_ADMIN.

-- Neue Rollenstufe über der Administration: sie vergibt Rollen und liest das
-- Prüfprotokoll. Beides will man nicht delegieren.
ALTER TYPE "UserRole" ADD VALUE 'SUPER_ADMIN';

-- Kontakt- und Auftrittskanäle am Mandanten. Strukturierte Geschäftsdaten
-- gehören hierher, nicht in die Inhaltsbausteine: sie erscheinen zusätzlich im
-- Impressum, in den strukturierten Daten und auf Belegen.
ALTER TABLE "organizations"
  ADD COLUMN "whatsapp"     TEXT,
  ADD COLUMN "mapsUrl"      TEXT,
  ADD COLUMN "facebookUrl"  TEXT,
  ADD COLUMN "instagramUrl" TEXT,
  ADD COLUMN "linkedinUrl"  TEXT,
  ADD COLUMN "tiktokUrl"    TEXT,
  ADD COLUMN "youtubeUrl"   TEXT;

-- Ein Schlüssel-Wert-Speicher für Website-Texte. Welche Schlüssel gültig sind
-- und welcher Text gilt, solange nichts gepflegt wurde, steht als Register im
-- Code (`lib/cms/registry.ts`).
CREATE TABLE "content_blocks" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key"            TEXT NOT NULL,
    "locale"         "Locale" NOT NULL DEFAULT 'DE',
    "value"          JSONB NOT NULL,
    "updatedById"    TEXT,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_blocks_pkey" PRIMARY KEY ("id")
);

-- Suchmaschinenangaben je Seitenpfad. Getrennt von den Inhaltsbausteinen, weil
-- sie an einer Route hängen und `noIndex` eine technische Schaltung ist.
CREATE TABLE "seo_meta" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "path"           TEXT NOT NULL,
    "locale"         "Locale" NOT NULL DEFAULT 'DE',
    "title"          TEXT,
    "description"    TEXT,
    "keywords"       TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ogImageUrl"     TEXT,
    "noIndex"        BOOLEAN NOT NULL DEFAULT false,
    "updatedById"    TEXT,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seo_meta_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "content_blocks_organizationId_locale_idx" ON "content_blocks"("organizationId", "locale");
CREATE UNIQUE INDEX "content_blocks_organizationId_key_locale_key" ON "content_blocks"("organizationId", "key", "locale");
CREATE UNIQUE INDEX "seo_meta_organizationId_path_locale_key" ON "seo_meta"("organizationId", "path", "locale");

ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "seo_meta" ADD CONSTRAINT "seo_meta_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
