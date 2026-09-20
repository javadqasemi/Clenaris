-- Elektronische Unterzeichnung — der Kern (Gate 4B).
--
-- Rein additiv: neun Aufzählungstypen, zwei erweiterte, vier Tabellen,
-- Indizes, Fremdschlüssel. Keine bestehende Spalte geändert, keine gelöscht,
-- keine Zeile umgeschrieben. Die Altfelder `signatureDataUrl`, `signatureName`,
-- `signatureIp`, `signedAt` an Offerte und Einsatz bleiben unverändert und
-- werden nicht zurückgefüllt: Beweise, die es nie gab (Snapshot, Zustimmung,
-- Prüfsumme, Ablauf), lassen sich nicht nachträglich erzeugen.
--
-- Zwei Dinge, die Prisma nicht ausdrücken kann und die deshalb von Hand am
-- Ende stehen:
--
--   1. CHECK auf `signature_requests`: genau eine Quelle (Offerte, Einsatz
--      oder Dokumentfassung). Eine generische `resourceType/resourceId`-
--      Kombination hätte die Fremdschlüssel gekostet.
--
--   2. `signature_events` ist **nur anhängen**. Kein Dienst besitzt eine
--      Funktion zum Ändern oder Löschen; zusätzlich lehnt die Datenbank
--      UPDATE, DELETE und TRUNCATE ab — auch für die Anwendung selbst, auch in
--      der Testdatenbank. Wer den Trigger entfernt, entfernt den Beweis.
--
-- `ADD VALUE` an bestehenden Typen ist in PostgreSQL 16 innerhalb der
-- Migrationstransaktion zulässig, solange der neue Wert nicht in derselben
-- Transaktion verwendet wird — wird er nicht.

-- CreateEnum
CREATE TYPE "SignatureProviderType" AS ENUM ('INTERNAL_EVIDENCE', 'QUALIFIED_EXTERNAL');

-- CreateEnum
CREATE TYPE "SignatureArtifactMode" AS ENUM ('EMBEDDED_VISUAL', 'DETACHED_EVIDENCE');

-- CreateEnum
CREATE TYPE "SignatureAssuranceLevel" AS ENUM ('LINK_ONLY', 'LINK_PLUS_EMAIL_CODE', 'LINK_PLUS_SMS_CODE');

-- CreateEnum
CREATE TYPE "SignatureRequestStatus" AS ENUM ('DRAFT', 'PENDING', 'FINALIZING', 'COMPLETED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SignatureParticipantRole" AS ENUM ('SIGNER', 'CC');

-- CreateEnum
CREATE TYPE "SignatureParticipantStatus" AS ENUM ('PENDING', 'VIEWED', 'VERIFIED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "SignatureMethod" AS ENUM ('DRAWN', 'TYPED');

-- CreateEnum
CREATE TYPE "SignatureEventType" AS ENUM ('REQUEST_CREATED', 'LINK_ISSUED', 'LINK_EXCHANGED', 'DOCUMENT_VIEWED', 'OTP_REQUESTED', 'OTP_VERIFIED', 'OTP_FAILED', 'CONSENT_ACCEPTED', 'SIGNATURE_SUBMITTED', 'FINALIZATION_STARTED', 'INTEGRITY_FAILED', 'SIGNED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'ARTIFACT_CREATED', 'REQUEST_COMPLETED', 'RESULT_LINK_ISSUED', 'RESULT_VIEWED');

-- CreateEnum
CREATE TYPE "SignatureOtpChannel" AS ENUM ('EMAIL', 'SMS');

-- AlterEnum
ALTER TYPE "FileScope" ADD VALUE 'SIGNATURE';

-- AlterEnum
ALTER TYPE "PublicTokenPurpose" ADD VALUE 'SIGNATURE_RESULT_VIEW';

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "status" "SignatureRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "providerType" "SignatureProviderType" NOT NULL DEFAULT 'INTERNAL_EVIDENCE',
    "artifactMode" "SignatureArtifactMode" NOT NULL DEFAULT 'DETACHED_EVIDENCE',
    "assuranceLevel" "SignatureAssuranceLevel" NOT NULL DEFAULT 'LINK_ONLY',
    "title" TEXT NOT NULL,
    "providerReference" TEXT,
    "quoteId" TEXT,
    "jobId" TEXT,
    "documentVersionId" TEXT,
    "originalArtifactId" TEXT NOT NULL,
    "originalDocumentHash" TEXT NOT NULL,
    "signedArtifactId" TEXT,
    "signedArtifactHash" TEXT,
    "evidenceArtifactId" TEXT,
    "evidenceArtifactHash" TEXT,
    "consentVersion" TEXT NOT NULL,
    "consentLocale" TEXT NOT NULL DEFAULT 'de-CH',
    "placementPage" INTEGER,
    "placementX" DECIMAL(8,2),
    "placementY" DECIMAL(8,2),
    "placementWidth" DECIMAL(8,2),
    "placementHeight" DECIMAL(8,2),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "finalizingSince" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "declinedAt" TIMESTAMPTZ(6),
    "expiredAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelledById" TEXT,
    "supersededById" TEXT,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_participants" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 1,
    "role" "SignatureParticipantRole" NOT NULL DEFAULT 'SIGNER',
    "status" "SignatureParticipantStatus" NOT NULL DEFAULT 'PENDING',
    "nameSnapshot" TEXT NOT NULL,
    "emailSnapshot" TEXT NOT NULL,
    "phoneSnapshot" TEXT,
    "customerId" TEXT,
    "viewedAt" TIMESTAMPTZ(6),
    "verifiedAt" TIMESTAMPTZ(6),
    "signedAt" TIMESTAMPTZ(6),
    "declinedAt" TIMESTAMPTZ(6),
    "declineReason" TEXT,
    "authenticationMethod" "SignatureAssuranceLevel",
    "signatureMethod" "SignatureMethod",
    "signedName" TEXT,
    "signatureArtifactId" TEXT,
    "signatureArtifactHash" TEXT,
    "consentTextSnapshot" TEXT,
    "consentTextHash" TEXT,
    "consentVersion" TEXT,
    "consentLocale" TEXT,
    "consentAcceptedAt" TIMESTAMPTZ(6),
    "ipAddress" TEXT,
    "ipSource" TEXT,
    "clientReportedUserAgent" TEXT,

    CONSTRAINT "signature_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_events" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "participantId" TEXT,
    "type" "SignatureEventType" NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "ipSource" TEXT,
    "clientReportedUserAgent" TEXT,
    "sessionRef" TEXT,
    "details" JSONB,

    CONSTRAINT "signature_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_otp_challenges" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "channel" "SignatureOtpChannel" NOT NULL,
    "sentTo" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "invalidatedAt" TIMESTAMPTZ(6),
    "resendAfter" TIMESTAMPTZ(6) NOT NULL,
    "sessionRef" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_publicId_key" ON "signature_requests"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_signedArtifactId_key" ON "signature_requests"("signedArtifactId");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_evidenceArtifactId_key" ON "signature_requests"("evidenceArtifactId");

-- CreateIndex
CREATE INDEX "signature_requests_organizationId_status_idx" ON "signature_requests"("organizationId", "status");

-- CreateIndex
CREATE INDEX "signature_requests_organizationId_createdAt_idx" ON "signature_requests"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "signature_requests_expiresAt_idx" ON "signature_requests"("expiresAt");

-- CreateIndex
CREATE INDEX "signature_requests_quoteId_idx" ON "signature_requests"("quoteId");

-- CreateIndex
CREATE INDEX "signature_requests_jobId_idx" ON "signature_requests"("jobId");

-- CreateIndex
CREATE INDEX "signature_requests_documentVersionId_idx" ON "signature_requests"("documentVersionId");

-- CreateIndex
CREATE INDEX "signature_requests_originalArtifactId_idx" ON "signature_requests"("originalArtifactId");

-- CreateIndex
CREATE UNIQUE INDEX "signature_participants_signatureArtifactId_key" ON "signature_participants"("signatureArtifactId");

-- CreateIndex
CREATE INDEX "signature_participants_requestId_status_idx" ON "signature_participants"("requestId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "signature_participants_requestId_order_key" ON "signature_participants"("requestId", "order");

-- CreateIndex
CREATE INDEX "signature_events_requestId_at_idx" ON "signature_events"("requestId", "at");

-- CreateIndex
CREATE INDEX "signature_otp_challenges_participantId_createdAt_idx" ON "signature_otp_challenges"("participantId", "createdAt");

-- CreateIndex
CREATE INDEX "signature_otp_challenges_expiresAt_idx" ON "signature_otp_challenges"("expiresAt");

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_originalArtifactId_fkey" FOREIGN KEY ("originalArtifactId") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_signedArtifactId_fkey" FOREIGN KEY ("signedArtifactId") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_evidenceArtifactId_fkey" FOREIGN KEY ("evidenceArtifactId") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_participants" ADD CONSTRAINT "signature_participants_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_participants" ADD CONSTRAINT "signature_participants_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_participants" ADD CONSTRAINT "signature_participants_signatureArtifactId_fkey" FOREIGN KEY ("signatureArtifactId") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "signature_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_otp_challenges" ADD CONSTRAINT "signature_otp_challenges_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "signature_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Von Hand: genau eine Quelle je Vorgang.
-- ---------------------------------------------------------------------------
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_genau_eine_quelle"
  CHECK (
    (("quoteId" IS NOT NULL)::int + ("jobId" IS NOT NULL)::int + ("documentVersionId" IS NOT NULL)::int) = 1
  );

-- ---------------------------------------------------------------------------
--  Von Hand: signature_events ist nur anhängen.
--
--  Ein Trigger je Zeile für UPDATE und DELETE, ein Trigger je Anweisung für
--  TRUNCATE. Die Funktion wirft mit SQLSTATE 55P03? Nein — bewusst ein eigener
--  Klartextfehler mit Klasse 'P0001' (raise_exception), damit die Anwendung
--  ihn als das erkennt, was er ist: kein Verbindungsproblem, sondern eine
--  Regel. Es gibt keinen Schalter, der sie umgeht.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION signature_events_nur_anhaengen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signature_events ist ein Protokoll: Zeilen werden angehängt, nie geändert oder gelöscht (% verweigert).', TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER signature_events_kein_update
  BEFORE UPDATE ON "signature_events"
  FOR EACH ROW EXECUTE FUNCTION signature_events_nur_anhaengen();

CREATE TRIGGER signature_events_kein_delete
  BEFORE DELETE ON "signature_events"
  FOR EACH ROW EXECUTE FUNCTION signature_events_nur_anhaengen();

CREATE TRIGGER signature_events_kein_truncate
  BEFORE TRUNCATE ON "signature_events"
  FOR EACH STATEMENT EXECUTE FUNCTION signature_events_nur_anhaengen();
