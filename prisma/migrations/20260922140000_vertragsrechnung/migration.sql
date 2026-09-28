-- Vertragsrechnung: Herkunft einer Rechnung aus Vertrag und Vertragsfassung.
--
-- Drei Spalten, und die dritte ist die tragende: `contractPeriodStart` ist der
-- kanonische Beginn der Abrechnungsperiode (Monatserster, Quartalsbeginn, …),
-- berechnet aus dem Zyklus der geltenden Vertragsversion. Er ist zugleich der
-- Schlüssel gegen Doppelabrechnung. Ein frei gewählter Zeitraum wäre keiner,
-- weil sich beliebig viele sich überlappende „Perioden" bilden liessen und
-- jede einzeln fakturierbar wäre.
--
-- Hinweis: `prisma migrate diff` schlägt bei jedem Lauf zusätzlich
--   ALTER TABLE "payroll_settings" ALTER COLUMN "updatedAt" DROP DEFAULT;
--   ALTER TABLE "payslips"         ALTER COLUMN "updatedAt" DROP DEFAULT;
-- vor. Das ist die von Hand gesetzte Korrektur aus Wave 9 und bleibt bewusst
-- stehen; der Vorschlag wird auch künftig erscheinen und ist auch künftig
-- nicht zu übernehmen.

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "contractPeriodStart" DATE,
ADD COLUMN     "contractVersionId" TEXT;

-- CreateIndex
CREATE INDEX "invoices_contractId_contractPeriodStart_idx" ON "invoices"("contractId", "contractPeriodStart");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contractVersionId_fkey" FOREIGN KEY ("contractVersionId") REFERENCES "contract_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
--  Eine Periode, eine Rechnung
-- ---------------------------------------------------------------------------
--
-- Von Hand ergänzt: Prisma kann einen Teilindex nicht ausdrücken, und ein
-- gewöhnlicher `@@unique` wäre hier falsch.
--
-- Warum überhaupt ein Index und nicht eine Prüfung im Dienst: Zwischen
-- „gibt es schon eine Rechnung für diese Periode?" und dem INSERT liegt ein
-- Moment. Ein zweiter Klick, ein Wiederholungsversuch nach einem Netzabbruch
-- und vor allem zwei gleichzeitige Läufe des Monatsabschlusses passen genau
-- hinein. Der Dienst prüft zwar vorher — das erspart im Normalfall eine
-- vergebliche Transaktion —, aber die Zusicherung steht hier.
--
-- Warum ein *Teil*index: Eine stornierte Rechnung darf die Periode nicht für
-- immer blockieren. Sonst wäre ein Fehler in der ersten Rechnung nicht mehr
-- korrigierbar: stornieren ginge, neu ausstellen nicht. Ebenso bleiben in den
-- Papierkorb verschobene Belege aussen vor.
--
-- Warum die NULL-Bedingung trotzdem dasteht, obwohl PostgreSQL NULLs in
-- Unique-Indizes ohnehin als verschieden behandelt: Sie hält den Index klein
-- und macht die Absicht lesbar — ohne Vertrag gibt es keine Periode.
CREATE UNIQUE INDEX "invoices_vertragsperiode_einmal"
  ON "invoices" ("contractId", "contractPeriodStart")
  WHERE "contractId" IS NOT NULL
    AND "contractPeriodStart" IS NOT NULL
    AND "status" <> 'CANCELLED'
    AND "deletedAt" IS NULL;
