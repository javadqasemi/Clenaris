-- Buchungslinks: Hash statt Klartext (2026-09-27).
--
-- `bookings.confirmationToken` hielt den Verwaltungslink jeder Buchung im
-- Klartext, ohne Ablauf und ohne Widerruf. Ein Datenbankabzug — Sicherung,
-- Supportkopie, Replikat — öffnete damit jede Gastbuchung samt Adresse und
-- Zugangshinweis. Offerten und Rechnungen laufen seit Gate 2.5 über
-- `public_access_tokens`; die Buchung hatte den Zweck `BOOKING_MANAGE`, stellte
-- ihn aber nie aus.
--
-- Die Spalte wird bewusst **gelöscht**, nicht nur geleert: Solange sie
-- besteht, kann ein Codepfad sie wieder befüllen, und eine leere Spalte mit
-- `@unique` sieht in jeder Prüfung wie ein Zugang aus. Verloren geht dabei
-- nichts, was gebraucht wird — jeder bereits versendete Link wird vorher als
-- SHA-256-Hash übernommen und funktioniert weiter.
--
-- Übernommen werden nur Werte in der Form, die die Anwendung erzeugt hat
-- (`randomToken(24)`: 48 Hexzeichen). Der Demobestand schrieb eigene,
-- alphanumerische Werte, die nie versendet wurden; sie verfallen mit der
-- Spalte. Frist wie bei neuen Links (`buchungslinkAusstellen`): 90 Tage nach
-- dem späteren von Terminende und heute — ein alter Link soll weder länger
-- gelten als ein neuer noch am Tag der Umstellung verfallen.
--
-- `sha256()` ist in PostgreSQL ab Version 11 eingebaut, `gen_random_uuid()` ab
-- Version 13; die Anwendung verlangt 16.

INSERT INTO "public_access_tokens" ("id", "organizationId", "tokenHash", "purpose", "resourceId", "expiresAt")
SELECT
  gen_random_uuid()::text,
  b."organizationId",
  encode(sha256(convert_to(b."confirmationToken", 'UTF8')), 'hex'),
  'BOOKING_MANAGE',
  b."id",
  GREATEST(b."scheduledEnd", CURRENT_TIMESTAMP) + INTERVAL '90 days'
FROM "bookings" b
WHERE b."confirmationToken" ~ '^[0-9a-f]{48}$'
  AND b."deletedAt" IS NULL
ON CONFLICT ("tokenHash") DO NOTHING;

DROP INDEX "bookings_confirmationToken_key";

ALTER TABLE "bookings" DROP COLUMN "confirmationToken";
