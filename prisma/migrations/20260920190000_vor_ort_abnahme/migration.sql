-- Gate 4D: Vor-Ort-Abnahme des Rapports auf dem uebergebenen Geraet.
--
-- Rein additiv: zwei Aufzaehlungstypen, vier Spalten, eine Tabelle, Indizes
-- und Fremdschluessel. Keine Zeile wird veraendert, keine Spalte entfernt,
-- kein Altbestandsfeld angefasst. Die drei Legacy-Signaturspalten an `jobs`
-- bleiben unberuehrt und lesbar.
--
-- Die beiden Teilindizes am Ende stehen von Hand, weil Prisma keine
-- Teilindizes kennt — wie schon in 20260920100000_signatur_kern (Trigger) und
-- 20260920160000_offert_annahme_eindeutig. Sie sind der eigentliche Punkt der
-- Migration: Gleichzeitigkeit gehoert in die Datenbank, nicht in die Maske.

-- CreateEnum
CREATE TYPE "SignatureCeremonyMode" AS ENUM ('REMOTE_LINK', 'AUTHENTICATED_CUSTOMER', 'IN_PERSON_HANDOFF');

-- CreateEnum
CREATE TYPE "DeviceHandoffStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "customerAcceptedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "signature_requests" ADD COLUMN     "ceremonyMode" "SignatureCeremonyMode" NOT NULL DEFAULT 'REMOTE_LINK',
ADD COLUMN     "presentedByEmployeeId" TEXT,
ADD COLUMN     "presentedById" TEXT,
ADD COLUMN     "presentedByName" TEXT;

-- CreateTable
CREATE TABLE "device_handoff_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "signatureRequestId" TEXT NOT NULL,
    "sessionFamily" TEXT NOT NULL,
    "status" "DeviceHandoffStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "releasedAt" TIMESTAMPTZ(6),

    CONSTRAINT "device_handoff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_handoff_sessions_organizationId_status_idx" ON "device_handoff_sessions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "device_handoff_sessions_userId_idx" ON "device_handoff_sessions"("userId");

-- CreateIndex
CREATE INDEX "device_handoff_sessions_jobId_idx" ON "device_handoff_sessions"("jobId");

-- CreateIndex
CREATE INDEX "device_handoff_sessions_signatureRequestId_idx" ON "device_handoff_sessions"("signatureRequestId");

-- CreateIndex
CREATE INDEX "device_handoff_sessions_sessionFamily_status_idx" ON "device_handoff_sessions"("sessionFamily", "status");

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_presentedById_fkey" FOREIGN KEY ("presentedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_handoff_sessions" ADD CONSTRAINT "device_handoff_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_handoff_sessions" ADD CONSTRAINT "device_handoff_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_handoff_sessions" ADD CONSTRAINT "device_handoff_sessions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_handoff_sessions" ADD CONSTRAINT "device_handoff_sessions_signatureRequestId_fkey" FOREIGN KEY ("signatureRequestId") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hoechstens eine offene Vor-Ort-Abnahme je Einsatz.
--
-- Vier gleichzeitige Tippser auf „Kundenabnahme vorbereiten" sollen einen
-- Vorgang mit einem Snapshot ergeben, nicht vier. Die Anwendung prueft das
-- vorher, aber eine Pruefung vor dem Schreiben ist kein Schutz gegen
-- Gleichzeitigkeit; der Index ist es. Abgeschlossene, abgebrochene und
-- abgelaufene Vorgaenge desselben Einsatzes duerfen nebeneinander bestehen —
-- eine korrigierte zweite Abnahme legt bewusst einen neuen Vorgang an, der
-- alte bleibt als Beweis.
CREATE UNIQUE INDEX "signature_requests_offene_abnahme_je_einsatz"
  ON "signature_requests" ("jobId")
  WHERE "jobId" IS NOT NULL
    AND "ceremonyMode" = 'IN_PERSON_HANDOFF'
    AND "status" IN ('DRAFT', 'PENDING', 'FINALIZING');

-- Hoechstens eine aktive Geraeteuebergabe je Browser.
--
-- `sessionFamily` benennt genau einen Browser (die Familie ueberlebt jede
-- Token-Rotation). Zwei aktive Uebergaben derselben Familie waeren ein
-- Widerspruch: Das Geraet ist entweder beim Kunden oder nicht. Der Index
-- macht daraus eine Zusicherung der Datenbank statt einer Annahme des
-- Dienstes — und er ist zugleich der Grund, warum das Entsperren idempotent
-- sein kann.
CREATE UNIQUE INDEX "device_handoff_sessions_eine_aktive_je_familie"
  ON "device_handoff_sessions" ("sessionFamily")
  WHERE "status" = 'ACTIVE';
