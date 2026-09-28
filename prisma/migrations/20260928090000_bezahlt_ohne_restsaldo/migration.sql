-- Bezahlt heisst: kein offener Posten (B-08, 2026-09-28).
--
-- `saldoNeuBilden` setzte „bezahlt", sobald höchstens fünf Rappen fehlten,
-- liess den Rest aber als `balance` stehen. Jede Stelle, die einen offenen
-- Posten an `balance > 0` erkennt (Kundenkonto, offene Posten, Kennzahlen,
-- Online-Zahlung), führte solche Rechnungen weiter als offen. Seit dieser
-- Fassung schreibt der Dienst 0; diese Migration bringt den Bestand auf
-- dieselbe Regel.
--
-- Nur Daten, kein Schema. Wiederholbar: Ein zweiter Lauf findet nichts mehr.
-- `balance` gehört nicht zu den Spalten, die der Trigger
-- `rechnung_unveraenderlich` an einer ausgestellten Rechnung schützt — der
-- Saldo folgt den Zahlungen, der Inhalt des Belegs bleibt unberührt.
-- Die Obergrenze 0.05 steht hier noch einmal, damit nie ein echter offener
-- Posten verschwindet.
UPDATE "invoices"
SET "balance" = 0
WHERE "status" = 'PAID'
  AND "balance" > 0
  AND "balance" <= 0.05;
