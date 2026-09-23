-- Wave 14 (2026-09-23): Zustellstatus für E-Mail und SMS.
--
-- Bis hierher kannte das Protokoll nur „simuliert", „gesendet" und
-- „fehlgeschlagen" — also das, was beim Übergeben an den Anbieter geschah.
-- Ob eine Nachricht ankam, abprallte oder als Spam gemeldet wurde, erfuhr
-- niemand. Die Anbieter melden das per Webhook; diese Spalten nehmen es auf,
-- die Indizes finden die Zeile über die Kennung des Anbieters.

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "deliveredAt" TIMESTAMPTZ(6),
ADD COLUMN     "statusAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "sms_logs" ADD COLUMN     "deliveredAt" TIMESTAMPTZ(6),
ADD COLUMN     "statusAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "email_logs_providerId_idx" ON "email_logs"("providerId");

-- CreateIndex
CREATE INDEX "email_logs_createdAt_idx" ON "email_logs"("createdAt");

-- CreateIndex
CREATE INDEX "sms_logs_providerId_idx" ON "sms_logs"("providerId");

-- CreateIndex
CREATE INDEX "sms_logs_entity_entityId_idx" ON "sms_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "sms_logs_createdAt_idx" ON "sms_logs"("createdAt");
