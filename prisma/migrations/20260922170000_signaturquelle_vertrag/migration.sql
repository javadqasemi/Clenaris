-- Die vierte Quelle des Signaturkerns: die Vertragsfassung.
--
-- `signature_requests_genau_eine_quelle` stammt aus Gate 4A und zählt drei
-- Spalten. `contractVersionId` kam mit Wave 10 dazu — die Bedingung kannte sie
-- nicht, und jeder Annahmevorgang einer Vertragsfassung scheiterte am CHECK
-- (23514). Gefunden hat das die Browserreihe, nicht eine Überlegung: Der
-- Endpunkt antwortete 500, und im Protokoll stand die Bedingung im Klartext.
--
-- Die Regel selbst bleibt dieselbe und ist der Grund, warum es sie gibt: Ein
-- Vorgang gehört zu **genau einem** Geschäftsobjekt. Zwei Quellen hiessen zwei
-- Fachregeln beim Abschluss, und welche gilt, wäre eine Frage der Reihenfolge
-- im Code statt eine Eigenschaft der Daten.
--
-- `DROP` und `ADD` statt `ALTER … VALIDATE`: PostgreSQL kennt kein Ändern
-- einer CHECK-Bedingung. Beides in einer Anweisungsfolge, damit zwischen den
-- beiden kein Zeitraum ohne Schutz liegt — die Migration läuft in einer
-- Transaktion.

ALTER TABLE "signature_requests" DROP CONSTRAINT "signature_requests_genau_eine_quelle";

ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_genau_eine_quelle"
  CHECK (
    (("quoteId" IS NOT NULL)::int
      + ("jobId" IS NOT NULL)::int
      + ("documentVersionId" IS NOT NULL)::int
      + ("contractVersionId" IS NOT NULL)::int) = 1
  );
