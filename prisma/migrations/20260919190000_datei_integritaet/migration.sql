-- Dateiintegrität: Upload-Ticket, Prüfsumme und die explizite Verbindung
-- zwischen physischer und fachlicher Dateiebene.
--
-- Rein additiv. Keine bestehende Spalte wird geändert, keine gelöscht, keine
-- Zeile umgeschrieben. Bestehende Datensätze erhalten:
--   stored_files.checksum = NULL      (ungeprüft, nicht „in Ordnung")
--   stored_files.driver   = 'LOCAL'   (sie stammen alle aus der Rückfallebene)
--   stored_files.profile  = NULL      (kein Ticket bekannt)
--   file_assets.storedFileId = NULL   (keine automatische Zuordnung)
--
-- Bewusst kein Backfill und keine Pfad-Heuristik in SQL: Welche Zeile zu
-- welchem Asset gehört, ist eine Entscheidung mit Sicherheitsfolgen und
-- gehört nicht in eine Migration, die niemand mehr liest.

-- CreateEnum
CREATE TYPE "StorageDriver" AS ENUM ('LOCAL', 'SUPABASE');

-- AlterTable
ALTER TABLE "file_assets" ADD COLUMN     "storedFileId" TEXT;

-- AlterTable
ALTER TABLE "stored_files" ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "driver" "StorageDriver" NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "profile" TEXT;

-- CreateIndex
-- Ein Ticket trägt höchstens ein Asset. PostgreSQL lässt beliebig viele NULL
-- zu, der Altbestand kollidiert also nicht; zwei gleichzeitige Abschlüsse
-- desselben Tickets dagegen schon — genau das ist der Zweck.
CREATE UNIQUE INDEX "file_assets_storedFileId_key" ON "file_assets"("storedFileId");

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_storedFileId_fkey" FOREIGN KEY ("storedFileId") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
