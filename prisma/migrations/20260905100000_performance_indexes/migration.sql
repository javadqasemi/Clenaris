-- Indizes für die Tabellen, die unbegrenzt wachsen.
--
-- Bewusst nur diese sieben: Ein Index auf einer Katalogtabelle mit sechs
-- Zeilen (Leistungen, Kategorien, Feiertage) kostet Schreiblast und Speicher,
-- ohne je gelesen zu werden — Postgres liest solche Tabellen ohnehin in einem
-- Rutsch. Massgebend war die Kombination aus „wächst mit dem Geschäft" und
-- „wird gefiltert *und* sortiert abgefragt".

-- Kennzahl „umsatzstärkste Kundschaft" auf der Übersicht.
CREATE INDEX "customers_organizationId_lifetimeValue_idx" ON "customers"("organizationId", "lifetimeValue");

-- Die Vertriebspipeline sortiert nach Bewertung, nicht nach Eingang.
CREATE INDEX "leads_organizationId_score_idx" ON "leads"("organizationId", "score");

-- Posteingang des Büros: alle offenen Verläufe, neueste zuerst.
CREATE INDEX "message_threads_closed_lastMessageAt_idx" ON "message_threads"("closed", "lastMessageAt");

-- Die Glocke lädt die neuesten Meldungen einer Person. Diese Tabelle wächst
-- mit jeder Buchung, jedem Einsatz und jeder Nachricht am schnellsten.
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- Die Zahlungsliste sortiert nach Erfassung, nicht nach Zahlungsdatum —
-- erfasst wird auch, was noch nicht bezahlt ist.
CREATE INDEX "payments_createdAt_idx" ON "payments"("createdAt");

-- Offertenliste im Büro, neueste zuerst.
CREATE INDEX "quotes_organizationId_createdAt_idx" ON "quotes"("organizationId", "createdAt");

-- Öffentliche Bewertungsliste: gefiltert nach Status, sortiert nach
-- Hervorhebung und Datum.
CREATE INDEX "reviews_organizationId_status_createdAt_idx" ON "reviews"("organizationId", "status", "createdAt");
