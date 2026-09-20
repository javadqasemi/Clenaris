-- Gate 4C: hoechstens ein offener Annahmevorgang je Offerte.
--
-- Zwei Browser, die gleichzeitig „Offerte annehmen" druecken, sollen genau
-- einen Unterzeichnungsvorgang ergeben — nicht zwei Snapshots mit zwei
-- Links. Die Anwendung prueft das vor dem Anlegen, aber eine Pruefung vor
-- dem Schreiben ist kein Schutz gegen Gleichzeitigkeit; der Index ist es.
-- Der Verlierer bekommt eine Eindeutigkeitsverletzung und verwendet den
-- Vorgang des Gewinners weiter.
--
-- Teilindex, weil abgeschlossene, abgebrochene und abgelaufene Vorgaenge
-- derselben Offerte nebeneinander bestehen duerfen: Ein neuer Versand nach
-- einer Aenderung legt bewusst einen neuen Vorgang an, der alte bleibt als
-- Beweis. Prisma kennt keine Teilindizes; deshalb von Hand, wie die Trigger
-- in 20260920100000_signatur_kern. Rein additiv, keine Zeile veraendert.

CREATE UNIQUE INDEX "signature_requests_offene_annahme_je_offerte"
  ON "signature_requests" ("quoteId")
  WHERE "quoteId" IS NOT NULL AND "status" IN ('DRAFT', 'PENDING', 'FINALIZING');
