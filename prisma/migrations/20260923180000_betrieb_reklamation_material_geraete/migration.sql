-- Wave 11 (2026-09-23): Reklamationen/Vorfälle mit Reaktionsfrist, Material mit
-- Lagerbewegungen, Geräte mit Wartung.
--
-- Von Hand ergänzt (am Ende): CHECK-Bedingungen und die Trigger, die
-- Lagerbewegungen und Wartungsbelege unveränderlich machen. `prisma validate`
-- kennt beides nicht; ein späteres `migrate dev` würde anbieten, sie zu
-- entfernen — nicht annehmen.

-- CreateEnum
CREATE TYPE "ComplaintKind" AS ENUM ('COMPLAINT', 'INCIDENT', 'DAMAGE');

-- CreateEnum
CREATE TYPE "ComplaintSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ComplaintChannel" AS ENUM ('PHONE', 'EMAIL', 'PORTAL', 'ON_SITE', 'OTHER');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('RECEIPT', 'ISSUE', 'RETURN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('AVAILABLE', 'IN_USE', 'MAINTENANCE', 'RETIRED');

-- CreateTable
CREATE TABLE "complaints" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ComplaintKind" NOT NULL DEFAULT 'COMPLAINT',
    "severity" "ComplaintSeverity" NOT NULL DEFAULT 'MEDIUM',
    "channel" "ComplaintChannel" NOT NULL DEFAULT 'PHONE',
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT,
    "contractId" TEXT,
    "contractVersionId" TEXT,
    "jobId" TEXT,
    "reportedAt" TIMESTAMPTZ(6) NOT NULL,
    "responseHours" INTEGER,
    "responseDueAt" TIMESTAMPTZ(6),
    "acknowledgedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "internalNote" TEXT,
    "assigneeId" TEXT,
    "reportedByUserId" TEXT,
    "correctiveActionId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'Stk.',
    "unitCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "minStock" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2),
    "jobId" TEXT,
    "materialUsageId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "inventoryNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "serialNumber" TEXT,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'AVAILABLE',
    "assignedEmployeeId" TEXT,
    "purchasedOn" DATE,
    "purchaseCost" DECIMAL(12,2),
    "maintenanceIntervalDays" INTEGER,
    "nextMaintenanceOn" DATE,
    "retiredAt" TIMESTAMPTZ(6),
    "retiredReason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_maintenances" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "performedOn" DATE NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'Wartung',
    "note" TEXT,
    "cost" DECIMAL(12,2),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_maintenances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "complaints_correctiveActionId_key" ON "complaints"("correctiveActionId");

-- CreateIndex
CREATE INDEX "complaints_organizationId_status_responseDueAt_idx" ON "complaints"("organizationId", "status", "responseDueAt");

-- CreateIndex
CREATE INDEX "complaints_customerId_reportedAt_idx" ON "complaints"("customerId", "reportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "complaints_organizationId_number_key" ON "complaints"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "materials_organizationId_sku_key" ON "materials"("organizationId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_materialUsageId_key" ON "stock_movements"("materialUsageId");

-- CreateIndex
CREATE INDEX "stock_movements_materialId_createdAt_idx" ON "stock_movements"("materialId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_organizationId_createdAt_idx" ON "stock_movements"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "equipment_organizationId_status_idx" ON "equipment"("organizationId", "status");

-- CreateIndex
CREATE INDEX "equipment_organizationId_nextMaintenanceOn_idx" ON "equipment"("organizationId", "nextMaintenanceOn");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_organizationId_inventoryNumber_key" ON "equipment"("organizationId", "inventoryNumber");

-- CreateIndex
CREATE INDEX "equipment_maintenances_equipmentId_performedOn_idx" ON "equipment_maintenances"("equipmentId", "performedOn");

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_correctiveActionId_fkey" FOREIGN KEY ("correctiveActionId") REFERENCES "corrective_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_materialUsageId_fkey" FOREIGN KEY ("materialUsageId") REFERENCES "material_usages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_maintenances" ADD CONSTRAINT "equipment_maintenances_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
--  Von Hand: Bedingungen, die das Schema nicht ausdrücken kann
-- ===========================================================================

-- Eine Zusage von null Stunden ist keine Zusage; negative Fristen gibt es nicht.
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_reaktionszeit_positiv"
  CHECK ("responseHours" IS NULL OR "responseHours" > 0);

-- Die Reaktion liegt nie vor der Meldung (sonst wäre jede Frist erfüllt).
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_reaktion_nach_meldung"
  CHECK ("acknowledgedAt" IS NULL OR "acknowledgedAt" >= "reportedAt");

ALTER TABLE "materials" ADD CONSTRAINT "materials_werte_nicht_negativ"
  CHECK ("minStock" >= 0 AND "unitCost" >= 0);

-- Vorzeichen passt zur Art: Eingang und Rückgabe positiv, Entnahme negativ,
-- Korrektur beliebig — aber nie null. Eine Bewegung über null ist keine.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vorzeichen"
  CHECK (
    "quantity" <> 0 AND (
      ("kind" IN ('RECEIPT', 'RETURN') AND "quantity" > 0) OR
      ("kind" = 'ISSUE' AND "quantity" < 0) OR
      ("kind" = 'ADJUSTMENT')
    )
  );

ALTER TABLE "equipment" ADD CONSTRAINT "equipment_intervall_positiv"
  CHECK ("maintenanceIntervalDays" IS NULL OR "maintenanceIntervalDays" > 0);

-- ===========================================================================
--  Von Hand: Lagerbewegungen und Wartungsbelege nur anfügen
-- ===========================================================================
--
-- Der Bestand ist die Summe der Bewegungen. Eine Bewegung, die sich ändern
-- oder löschen lässt, macht den Bestand zu einer Zahl ohne Erklärung. Die
-- Berichtigung ist eine Gegenbuchung.
--
-- Zwei Ausnahmen, beide ohne Wirkung auf den Bestand:
--  * Kaskaden (pg_trigger_depth() > 1) — das Löschen einer ganzen
--    Organisation muss möglich bleiben.
--  * Das Lösen eines Verweises auf einen gelöschten Einsatz oder eine
--    gelöschte Materialzeile (ON DELETE SET NULL). Menge, Art und Material
--    bleiben dabei unverändert; nur `jobId`/`materialUsageId` werden leer.

CREATE OR REPLACE FUNCTION stock_movements_nur_anfuegen() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."organizationId" = OLD."organizationId"
     AND NEW."materialId" = OLD."materialId"
     AND NEW."kind" = OLD."kind"
     AND NEW."quantity" = OLD."quantity"
     AND NEW."unitCost" IS NOT DISTINCT FROM OLD."unitCost"
     AND NEW."reference" IS NOT DISTINCT FROM OLD."reference"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."createdAt" = OLD."createdAt"
     AND (NEW."jobId" IS NOT DISTINCT FROM OLD."jobId" OR NEW."jobId" IS NULL)
     AND (NEW."materialUsageId" IS NOT DISTINCT FROM OLD."materialUsageId" OR NEW."materialUsageId" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Lagerbewegungen sind unveränderlich — berichtigen Sie mit einer Gegenbuchung.'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_nur_anfuegen
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION stock_movements_nur_anfuegen();

CREATE OR REPLACE FUNCTION equipment_maintenances_unveraenderlich() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'Ein Wartungsbeleg ist unveränderlich.' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER equipment_maintenances_unveraenderlich
  BEFORE UPDATE OR DELETE ON "equipment_maintenances"
  FOR EACH ROW EXECUTE FUNCTION equipment_maintenances_unveraenderlich();
