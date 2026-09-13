-- AlterTable
ALTER TABLE "content_blocks" ADD COLUMN     "draftValue" JSONB,
ADD COLUMN     "publishedAt" TIMESTAMPTZ(6);
-- AlterTable
ALTER TABLE "legal_documents" ALTER COLUMN "effectiveFrom" SET DEFAULT CURRENT_TIMESTAMP;
-- CreateTable
CREATE TABLE "content_revisions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'DE',
    "value" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_revisions_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "content_revisions_blockId_createdAt_idx" ON "content_revisions"("blockId", "createdAt");
-- CreateIndex
CREATE INDEX "content_revisions_organizationId_createdAt_idx" ON "content_revisions"("organizationId", "createdAt");
-- AddForeignKey
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "content_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bestehende Bausteine gelten als veroeffentlicht: ihr Wert ist genau das,
-- was die Website heute zeigt. Ohne diesen Schritt stuende die Historie bei
-- jedem gepflegten Text auf `nie veroeffentlicht`.
UPDATE "content_blocks" SET "publishedAt" = "updatedAt" WHERE "publishedAt" IS NULL;
