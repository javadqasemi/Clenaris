-- Ein verworfener Versionsentwurf (RB-002).
--
-- Additiv. Eigene Migration, weil `ALTER TYPE … ADD VALUE` in PostgreSQL vor
-- Version 12 nicht in einer Transaktion mit anderen Anweisungen laufen darf
-- und der neue Wert erst nach dem Commit benutzbar ist.
--
-- Warum ein Zustand und kein Löschen: Ein Entwurf, der einmal zur
-- Unterzeichnung verschickt und zurückgezogen wurde, trägt einen
-- `SignatureRequest` mit `ON DELETE RESTRICT` — der Vorgang ist ein Beleg.
-- Löschen scheiterte dort; verwerfen hält Fassung, Vorgang und Protokoll
-- zusammen.
--
-- Der Trigger `contract_versions_unveraenderlich` lässt DRAFT → DISCARDED nur
-- an einer **freien** Fassung zu: Eine gesperrte (angenommen oder in
-- Unterzeichnung) darf ausschliesslich DRAFT → ACTIVE.

ALTER TYPE "ContractVersionStatus" ADD VALUE IF NOT EXISTS 'DISCARDED';
