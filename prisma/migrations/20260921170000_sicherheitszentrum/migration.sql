-- Sicherheitszentrum (Wave 3)
--
-- Rein additiv: zwei Aufzählungstypen, eine Tabelle, vier Indizes, drei
-- Fremdschlüssel. Kein DROP, kein verlustbehaftetes ALTER, kein Rückschreiben
-- in bestehende Zeilen.
--
-- Bewusst **ohne** Rückfüllung. Anders als bei der Dateiprüfung in Wave 2 gibt
-- es hier nichts nachzutragen: Ein Sicherheitsereignis ist ein Ereignis, kein
-- Zustand. Was vor dieser Migration geschah, steht im Prüfprotokoll und an den
-- Datensätzen selbst (`lockedUntil`, `sessionsRevokedAt`, `scanStatus`) — es
-- nachträglich als Ereignis zu erfinden, hiesse, Zeitpunkte zu behaupten, die
-- niemand gemessen hat. Der Strom beginnt hier und ist ab hier vollständig.

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SecurityCategory" AS ENUM ('AUTHENTICATION', 'SESSION', 'ACCESS', 'PUBLIC_LINK', 'FILE', 'SYSTEM');

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "category" "SecurityCategory" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "context" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "acknowledgedById" TEXT,
    "acknowledgedNote" TEXT,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_organizationId_occurredAt_idx" ON "security_events"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "security_events_organizationId_severity_acknowledgedAt_idx" ON "security_events"("organizationId", "severity", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "security_events_organizationId_category_occurredAt_idx" ON "security_events"("organizationId", "category", "occurredAt");

-- CreateIndex
CREATE INDEX "security_events_userId_occurredAt_idx" ON "security_events"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Kein Änderungs- oder Löschschutz per Trigger — und warum nicht
-- ---------------------------------------------------------------------------
--
-- `signature_events` trägt einen Anfüge-nur-Trigger, weil dort Beweiskraft die
-- ganze Existenzberechtigung ist: Ein Protokoll, dessen Zeilen sich ändern
-- lassen, beweist eine Unterschrift nicht.
--
-- Hier ist es anders, und zwar in beide Richtungen. Zeilen werden absichtlich
-- geändert — `acknowledgedAt` und `acknowledgedNote` entstehen erst später,
-- und ein Trigger, der UPDATE verbietet, müsste genau diese Spalten ausnehmen
-- und wäre damit kein Schutz mehr, sondern eine Einladung. Und gelöscht werden
-- muss: Ein Ereignisstrom ohne Aufbewahrungsgrenze wächst unbegrenzt, und
-- gerade die Alltagsereignisse (`INFO`) sind nach Monaten wertlos.
--
-- Die Aufbewahrung gehört nach Wave 24 (Löschfristen) und wird dort einheitlich
-- geregelt. Bis dahin löscht nichts diese Tabelle.
