-- CreateTable
CREATE TABLE "stored_files" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "maxBytes" INTEGER NOT NULL,
    "data" BYTEA,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "stored_files_organizationId_createdAt_idx" ON "stored_files"("organizationId", "createdAt");
-- CreateIndex
CREATE INDEX "stored_files_expiresAt_idx" ON "stored_files"("expiresAt");
-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
