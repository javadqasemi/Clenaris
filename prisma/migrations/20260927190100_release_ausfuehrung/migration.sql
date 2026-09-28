-- Ausführung eines Aktualisierungsauftrags durch einen vertrauenswürdigen
-- Ausführer ausserhalb der Anwendung (2026-09-27,
-- `release-ausfuehrung.service.ts`). Nur hinzufügend.

ALTER TABLE "release_requests"
  ADD COLUMN "executorId" TEXT,
  ADD COLUMN "executionKey" TEXT,
  ADD COLUMN "environment" TEXT,
  ADD COLUMN "verifiedSha256" TEXT,
  ADD COLUMN "ciEvidence" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMPTZ(6),
  ADD COLUMN "finishedAt" TIMESTAMPTZ(6),
  ADD COLUMN "resultMessage" TEXT,
  ADD COLUMN "rollbackVersion" TEXT;

CREATE UNIQUE INDEX "release_requests_executionKey_key" ON "release_requests"("executionKey");

-- Von Hand, Prisma kann ihn nicht ausdrücken (siehe
-- `20260926100000_versionsverwaltung`): höchstens ein offener Auftrag je
-- Organisation und Version. „Offen" umfasst jetzt auch einen Auftrag in
-- Ausführung — sonst liesse sich dieselbe Version während der Installation
-- ein zweites Mal freigeben und terminieren, und ein zweiter Ausführer
-- übernähme sie. Ein späteres `migrate dev` wird anbieten, diesen Index zu
-- entfernen; nicht annehmen.
DROP INDEX IF EXISTS "release_requests_offen_einmal";
CREATE UNIQUE INDEX "release_requests_offen_einmal"
    ON "release_requests" ("organizationId", "releaseId")
    WHERE "status" IN ('APPROVED', 'SCHEDULED', 'DEPLOYING');
