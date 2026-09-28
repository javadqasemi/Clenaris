-- Versionsverwaltung (Produktsprint 2026-09-26)
--
-- Drei neue Tabellen, nichts an bestehenden geändert. `releases` beschreibt
-- eine Version, `release_requests` hält die Entscheidung des Betriebs
-- (freigegeben, terminiert, storniert), `release_deferrals` das „Nicht jetzt".
-- Ausgeführt wird von der Anwendung aus nichts; siehe
-- `src/server/services/release.service.ts`.

-- CreateEnum
CREATE TYPE "ReleaseKind" AS ENUM ('PATCH', 'MINOR', 'MAJOR', 'SECURITY');

-- CreateEnum
CREATE TYPE "ReleaseSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ReleaseCiStatus" AS ENUM ('PASSED', 'FAILED', 'PENDING');

-- CreateEnum
CREATE TYPE "ReleaseRequestStatus" AS ENUM ('APPROVED', 'SCHEDULED', 'CANCELLED');

-- CreateTable
CREATE TABLE "releases" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "releasedAt" TIMESTAMPTZ(6) NOT NULL,
    "kind" "ReleaseKind" NOT NULL,
    "securitySeverity" "ReleaseSeverity",
    "summary" TEXT NOT NULL,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "securityFixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uiChanges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "migrations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "breakingChanges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manualActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedDowntimeMinutes" INTEGER,
    "rollbackAvailable" BOOLEAN NOT NULL DEFAULT true,
    "ciStatus" "ReleaseCiStatus" NOT NULL DEFAULT 'PENDING',
    "compatibility" TEXT,
    "commit" TEXT,
    "artifactSha256" TEXT,
    "artifactSizeBytes" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "status" "ReleaseRequestStatus" NOT NULL,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "scheduledFor" TIMESTAMPTZ(6),
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMPTZ(6) NOT NULL,
    "scheduledById" TEXT,
    "scheduledAt" TIMESTAMPTZ(6),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "release_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_deferrals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "deferredById" TEXT NOT NULL,
    "deferredUntil" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_deferrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "releases_version_key" ON "releases"("version");

-- CreateIndex
CREATE INDEX "releases_releasedAt_idx" ON "releases"("releasedAt");

-- CreateIndex
CREATE INDEX "release_requests_organizationId_status_idx" ON "release_requests"("organizationId", "status");

-- CreateIndex
CREATE INDEX "release_requests_releaseId_idx" ON "release_requests"("releaseId");

-- CreateIndex
CREATE INDEX "release_deferrals_organizationId_releaseId_deferredUntil_idx" ON "release_deferrals"("organizationId", "releaseId", "deferredUntil");

-- AddForeignKey
ALTER TABLE "release_requests" ADD CONSTRAINT "release_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_requests" ADD CONSTRAINT "release_requests_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_deferrals" ADD CONSTRAINT "release_deferrals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_deferrals" ADD CONSTRAINT "release_deferrals_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Von Hand: höchstens ein offener Auftrag je Organisation und Version.
--
--  Prisma kann einen partiellen Index nicht ausdrücken; `prisma migrate dev`
--  würde ihn deshalb zum Löschen vorschlagen. Nicht annehmen.
--
--  Warum in der Datenbank und nicht nur im Dienst: Zwei Systemverantwortliche,
--  die dieselbe Version im selben Augenblick freigeben, kämen beide an der
--  Zustandsprüfung im Dienst vorbei — sie lesen denselben Stand. Das zweite
--  Einfügen scheitert hier, und der Dienst meldet es als 409. Stornierte
--  Aufträge sind ausgenommen: Nach einem Storno muss die Version erneut
--  freigegeben werden können, und die stornierte Zeile bleibt als Nachweis.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "release_requests_offen_einmal"
    ON "release_requests" ("organizationId", "releaseId")
    WHERE "status" IN ('APPROVED', 'SCHEDULED');
