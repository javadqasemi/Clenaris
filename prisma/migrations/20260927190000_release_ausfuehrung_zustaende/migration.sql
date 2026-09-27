-- Ausführungszustände eines Aktualisierungsauftrags (2026-09-27).
--
-- Eigene Migration, getrennt von den Spalten und dem Index in
-- `20260927190100_release_ausfuehrung`: PostgreSQL erlaubt einen mit
-- `ALTER TYPE … ADD VALUE` angelegten Wert nicht in derselben Transaktion zu
-- verwenden („unsafe use of new value"), und ein Skript mit mehreren
-- Anweisungen läuft als eine Transaktion. Der Teilindex dort braucht
-- 'DEPLOYING' in seiner Bedingung.

ALTER TYPE "ReleaseRequestStatus" ADD VALUE IF NOT EXISTS 'DEPLOYING';
ALTER TYPE "ReleaseRequestStatus" ADD VALUE IF NOT EXISTS 'SUCCEEDED';
ALTER TYPE "ReleaseRequestStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "ReleaseRequestStatus" ADD VALUE IF NOT EXISTS 'ROLLED_BACK';
