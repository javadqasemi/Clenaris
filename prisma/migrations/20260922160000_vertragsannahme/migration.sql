-- Elektronische Annahme einer Vertragsfassung (Wave 10, § 12).
--
-- Unterzeichnet wird immer eine konkrete Fassung, nie „der Vertrag".
-- `acceptedRequestId` zeigt auf den abgeschlossenen Signaturvorgang und ist
-- eindeutig: Der Beweis lässt sich damit in beide Richtungen führen — vom
-- Protokoll zur Fassung und von der Fassung zum Protokoll.
--
-- Hinweis: Der `DROP DEFAULT` auf `payroll_settings`/`payslips`, den
-- `prisma migrate diff` weiterhin vorschlägt, ist die Handkorrektur aus
-- Wave 9 und wird auch hier nicht übernommen.

-- AlterTable
ALTER TABLE "contract_versions" ADD COLUMN     "acceptedAt" TIMESTAMPTZ(6),
ADD COLUMN     "acceptedRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_acceptedRequestId_key" ON "contract_versions"("acceptedRequestId");

-- ---------------------------------------------------------------------------
--  Ein offener Annahmevorgang je Vertragsfassung
-- ---------------------------------------------------------------------------
--
-- Von Hand ergänzt; Prisma kann einen Teilindex nicht ausdrücken. Dieselbe
-- Bauart wie `signature_requests_offene_annahme_je_offerte` aus Gate 4C und
-- aus demselben Grund: Zweimal auf „Zur Unterschrift senden" geklickt darf
-- nicht zwei Vorgänge mit zwei verschiedenen Snapshots derselben Fassung
-- erzeugen. Welcher davon später gilt, wäre sonst eine Frage der Reihenfolge
-- — und beide trügen eine echte Unterschrift.
--
-- Abgeschlossene, abgebrochene und abgelaufene Vorgänge stehen ausserhalb der
-- Bedingung: Nach einem Abbruch muss sich eine Fassung erneut zur Annahme
-- schicken lassen.
CREATE UNIQUE INDEX "signature_requests_offene_annahme_je_vertragsfassung"
  ON "signature_requests" ("contractVersionId")
  WHERE "contractVersionId" IS NOT NULL
    AND "status" IN ('DRAFT', 'PENDING', 'FINALIZING');
