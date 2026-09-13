-- CreateEnum
CREATE TYPE "KpiUnit" AS ENUM ('CURRENCY', 'PERCENT', 'COUNT', 'DAYS', 'HOURS', 'RATIO');

-- CreateEnum
CREATE TYPE "KpiDirection" AS ENUM ('UP_IS_GOOD', 'DOWN_IS_GOOD');

-- CreateEnum
CREATE TYPE "KpiPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR');

-- CreateEnum
CREATE TYPE "KpiSource" AS ENUM ('DERIVED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ObjectiveHorizon" AS ENUM ('STRATEGY', 'OBJECTIVE', 'INITIATIVE');

-- CreateEnum
CREATE TYPE "ObjectiveLevel" AS ENUM ('COMPANY', 'DEPARTMENT', 'PERSONAL');

-- CreateEnum
CREATE TYPE "ObjectiveStatus" AS ENUM ('DRAFT', 'ACTIVE', 'AT_RISK', 'ACHIEVED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'APPROVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InvestmentStatus" AS ENUM ('PLANNED', 'APPROVED', 'ORDERED', 'ACTIVE', 'DISPOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('NONE', 'STRAIGHT_LINE', 'DECLINING');

-- CreateEnum
CREATE TYPE "ScenarioKind" AS ENUM ('BEST', 'EXPECTED', 'WORST');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('FINANCIAL', 'OPERATIONAL', 'PERSONNEL', 'LEGAL', 'DATA_PROTECTION', 'IT_SECURITY', 'REPUTATION', 'MARKET', 'ENVIRONMENT');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('IDENTIFIED', 'ASSESSED', 'MITIGATING', 'ACCEPTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ControlKind" AS ENUM ('SOP', 'QUALITY_STANDARD', 'COMPLIANCE', 'CONTINUITY');

-- CreateEnum
CREATE TYPE "ControlStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DUE', 'NON_COMPLIANT', 'RETIRED');

-- CreateEnum
CREATE TYPE "ActionKind" AS ENUM ('CORRECTIVE', 'PREVENTIVE', 'IMPROVEMENT');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('BUSINESS_PLAN', 'CONTRACT', 'INSURANCE', 'EMPLOYEE', 'CERTIFICATE', 'LICENSE', 'SUPPLIER', 'TAX', 'LEGAL', 'POLICY', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentVisibility" AS ENUM ('MANAGEMENT', 'OPERATIONS', 'STAFF', 'EMPLOYEE_PRIVATE');

-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('INDUSTRY', 'CUSTOMER', 'COMPETITOR', 'TECHNOLOGY', 'ECONOMY', 'LEGAL', 'ENVIRONMENT');

-- CreateEnum
CREATE TYPE "AnalysisKind" AS ENUM ('SWOT', 'PESTEL');

-- CreateEnum
CREATE TYPE "AnalysisBucket" AS ENUM ('STRENGTH', 'WEAKNESS', 'OPPORTUNITY', 'THREAT', 'POLITICAL', 'ECONOMIC', 'SOCIAL', 'TECHNOLOGICAL', 'ENVIRONMENTAL', 'LEGAL');

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('BUSINESS_PERFORMANCE', 'FINANCIAL', 'MARKETING', 'SALES', 'EMPLOYEE', 'CUSTOMER', 'QUARTERLY_REVIEW');

-- CreateEnum
CREATE TYPE "ReportCadence" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'XLSX', 'DOCX');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "acquisitionCampaign" TEXT,
ADD COLUMN     "acquisitionSource" TEXT;

-- AlterTable
ALTER TABLE "file_assets" ADD COLUMN     "articleId" TEXT,
ADD COLUMN     "controlId" TEXT,
ADD COLUMN     "investmentId" TEXT,
ADD COLUMN     "meetingId" TEXT,
ADD COLUMN     "objectiveId" TEXT,
ADD COLUMN     "riskId" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "weeklyHours" DECIMAL(4,1) NOT NULL DEFAULT 42;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "meetingId" TEXT,
ADD COLUMN     "objectiveId" TEXT;

-- CreateTable
CREATE TABLE "kpi_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "group" TEXT NOT NULL DEFAULT 'Finanzen',
    "unit" "KpiUnit" NOT NULL DEFAULT 'CURRENCY',
    "direction" "KpiDirection" NOT NULL DEFAULT 'UP_IS_GOOD',
    "source" "KpiSource" NOT NULL DEFAULT 'DERIVED',
    "periods" "KpiPeriod"[] DEFAULT ARRAY['MONTH']::"KpiPeriod"[],
    "targetValue" DECIMAL(14,2),
    "warnValue" DECIMAL(14,2),
    "healthWeight" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kpi_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_targets" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "period" "KpiPeriod" NOT NULL,
    "periodStart" DATE NOT NULL,
    "targetValue" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "period" "KpiPeriod" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "targetValue" DECIMAL(14,2),
    "previousYearValue" DECIMAL(14,2),
    "sampleSize" INTEGER,
    "breakdown" JSONB,
    "provisional" BOOLEAN NOT NULL DEFAULT true,
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "takenOn" DATE NOT NULL,
    "score" INTEGER NOT NULL,
    "scoreDelta" INTEGER,
    "components" JSONB NOT NULL,
    "topRisk" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "objectives" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "horizon" "ObjectiveHorizon" NOT NULL DEFAULT 'OBJECTIVE',
    "level" "ObjectiveLevel" NOT NULL DEFAULT 'COMPANY',
    "status" "ObjectiveStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "department" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "parentId" TEXT,
    "ownerId" TEXT,
    "fiscalYear" INTEGER,
    "quarter" INTEGER,
    "startsOn" DATE,
    "endsOn" DATE,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "reviewIntervalDays" INTEGER,
    "nextReviewAt" DATE,
    "lastReviewedAt" DATE,
    "budgetAmount" DECIMAL(12,2),
    "expectedRoiPct" DECIMAL(6,2),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_results" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kpiDefinitionId" TEXT,
    "kpiPeriod" "KpiPeriod",
    "unit" "KpiUnit" NOT NULL DEFAULT 'COUNT',
    "direction" "KpiDirection" NOT NULL DEFAULT 'UP_IS_GOOD',
    "startValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "targetValue" DECIMAL(14,2) NOT NULL,
    "currentValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "lastCheckinAt" TIMESTAMPTZ(6),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "key_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_result_checkins" (
    "id" TEXT NOT NULL,
    "keyResultId" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "comment" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_result_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_periods" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMPTZ(6),
    "approvedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "plannedAmount" DECIMAL(12,2) NOT NULL,
    "revisedAmount" DECIMAL(12,2),
    "monthlyPlan" DECIMAL(12,2)[],
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'EQUIPMENT',
    "status" "InvestmentStatus" NOT NULL DEFAULT 'PLANNED',
    "description" TEXT,
    "supplierId" TEXT,
    "purchaseAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CHF',
    "plannedOn" DATE,
    "purchasedOn" DATE,
    "commissionedOn" DATE,
    "disposedOn" DATE,
    "disposalProceeds" DECIMAL(12,2),
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "usefulLifeYears" INTEGER,
    "residualValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expectedAnnualBenefit" DECIMAL(12,2),
    "assetTag" TEXT,
    "location" TEXT,
    "ownerId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "investments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ScenarioKind" NOT NULL DEFAULT 'EXPECTED',
    "fiscalYear" INTEGER NOT NULL,
    "horizonMonths" INTEGER NOT NULL DEFAULT 12,
    "description" TEXT,
    "openingCash" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "result" JSONB,
    "computedAt" TIMESTAMPTZ(6),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_assumptions" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "unit" "KpiUnit" NOT NULL DEFAULT 'COUNT',
    "monthlyChangePct" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scenario_assumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "RiskCategory" NOT NULL DEFAULT 'OPERATIONAL',
    "status" "RiskStatus" NOT NULL DEFAULT 'IDENTIFIED',
    "probability" INTEGER NOT NULL DEFAULT 3,
    "impact" INTEGER NOT NULL DEFAULT 3,
    "severity" INTEGER NOT NULL DEFAULT 9,
    "residualProbability" INTEGER,
    "residualImpact" INTEGER,
    "residualSeverity" INTEGER,
    "potentialLoss" DECIMAL(12,2),
    "mitigationPlan" TEXT,
    "ownerId" TEXT,
    "reviewIntervalDays" INTEGER NOT NULL DEFAULT 90,
    "nextReviewAt" DATE,
    "lastReviewedAt" DATE,
    "reviewLog" JSONB,
    "closedAt" TIMESTAMPTZ(6),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "risk_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "ControlKind" NOT NULL DEFAULT 'SOP',
    "status" "ControlStatus" NOT NULL DEFAULT 'DRAFT',
    "reference" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "evidenceNote" TEXT,
    "ownerId" TEXT,
    "reviewIntervalDays" INTEGER NOT NULL DEFAULT 180,
    "nextReviewAt" DATE,
    "lastReviewedAt" DATE,
    "reviewLog" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "control_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corrective_actions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "ActionKind" NOT NULL DEFAULT 'CORRECTIVE',
    "title" TEXT NOT NULL,
    "rootCause" TEXT,
    "description" TEXT,
    "riskId" TEXT,
    "controlId" TEXT,
    "reviewId" TEXT,
    "taskId" TEXT,
    "dueOn" DATE,
    "completedAt" TIMESTAMPTZ(6),
    "effectivenessCheckedAt" DATE,
    "effectivenessNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "corrective_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_documents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL DEFAULT 'OTHER',
    "visibility" "DocumentVisibility" NOT NULL DEFAULT 'MANAGEMENT',
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subjectEmployeeId" TEXT,
    "supplierId" TEXT,
    "validFrom" DATE,
    "expiresOn" DATE,
    "reminderDaysBefore" INTEGER NOT NULL DEFAULT 30,
    "expiryNotifiedAt" DATE,
    "currentVersionId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "managed_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "changeNote" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_articles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Allgemein',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "DocumentVisibility" NOT NULL DEFAULT 'STAFF',
    "videoUrl" TEXT,
    "reviewIntervalDays" INTEGER,
    "nextReviewAt" DATE,
    "publishedAt" TIMESTAMPTZ(6),
    "authorId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "region" TEXT,
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priceFrom" DECIMAL(12,2),
    "priceTo" DECIMAL(12,2),
    "priceNote" TEXT,
    "strengths" TEXT,
    "weaknesses" TEXT,
    "marketPosition" TEXT,
    "reviewScore" DECIMAL(3,2),
    "reviewCount" INTEGER,
    "notes" TEXT,
    "reviewIntervalDays" INTEGER NOT NULL DEFAULT 180,
    "nextReviewAt" DATE,
    "lastReviewedAt" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_insights" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "InsightKind" NOT NULL DEFAULT 'INDUSTRY',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceName" TEXT,
    "observedOn" DATE NOT NULL,
    "impactNote" TEXT,
    "reviewIntervalDays" INTEGER NOT NULL DEFAULT 365,
    "nextReviewAt" DATE,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "market_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_boards" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "AnalysisKind" NOT NULL,
    "title" TEXT NOT NULL,
    "preparedOn" DATE NOT NULL,
    "summary" TEXT,
    "supersededById" TEXT,
    "reviewIntervalDays" INTEGER NOT NULL DEFAULT 365,
    "nextReviewAt" DATE,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "analysis_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_entries" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "bucket" "AnalysisBucket" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 3,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "analysis_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "heldAt" TIMESTAMPTZ(6) NOT NULL,
    "location" TEXT,
    "agenda" TEXT,
    "minutes" TEXT,
    "decisions" TEXT,
    "guestNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "objectiveId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_participants" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attended" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL DEFAULT 'BUSINESS_PERFORMANCE',
    "cadence" "ReportCadence" NOT NULL DEFAULT 'MONTHLY',
    "format" "ReportFormat" NOT NULL DEFAULT 'PDF',
    "runOnDay" INTEGER NOT NULL DEFAULT 1,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMPTZ(6),
    "nextRunAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_runs" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT,
    "organizationId" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "fileAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kpi_definitions_organizationId_active_sortOrder_idx" ON "kpi_definitions"("organizationId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_definitions_organizationId_key_key" ON "kpi_definitions"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_targets_definitionId_period_periodStart_key" ON "kpi_targets"("definitionId", "period", "periodStart");

-- CreateIndex
CREATE INDEX "kpi_snapshots_organizationId_period_periodStart_idx" ON "kpi_snapshots"("organizationId", "period", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_snapshots_definitionId_period_periodStart_key" ON "kpi_snapshots"("definitionId", "period", "periodStart");

-- CreateIndex
CREATE INDEX "health_snapshots_organizationId_takenOn_idx" ON "health_snapshots"("organizationId", "takenOn");

-- CreateIndex
CREATE UNIQUE INDEX "health_snapshots_organizationId_takenOn_key" ON "health_snapshots"("organizationId", "takenOn");

-- CreateIndex
CREATE INDEX "objectives_organizationId_status_horizon_idx" ON "objectives"("organizationId", "status", "horizon");

-- CreateIndex
CREATE INDEX "objectives_organizationId_fiscalYear_quarter_idx" ON "objectives"("organizationId", "fiscalYear", "quarter");

-- CreateIndex
CREATE INDEX "objectives_ownerId_idx" ON "objectives"("ownerId");

-- CreateIndex
CREATE INDEX "objectives_nextReviewAt_idx" ON "objectives"("nextReviewAt");

-- CreateIndex
CREATE INDEX "key_results_objectiveId_sortOrder_idx" ON "key_results"("objectiveId", "sortOrder");

-- CreateIndex
CREATE INDEX "key_result_checkins_keyResultId_recordedAt_idx" ON "key_result_checkins"("keyResultId", "recordedAt");

-- CreateIndex
CREATE INDEX "budget_periods_organizationId_fiscalYear_idx" ON "budget_periods"("organizationId", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "budget_periods_organizationId_fiscalYear_name_key" ON "budget_periods"("organizationId", "fiscalYear", "name");

-- CreateIndex
CREATE INDEX "budget_lines_periodId_category_idx" ON "budget_lines"("periodId", "category");

-- CreateIndex
CREATE INDEX "investments_organizationId_status_idx" ON "investments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "investments_organizationId_category_idx" ON "investments"("organizationId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "investments_organizationId_assetTag_key" ON "investments"("organizationId", "assetTag");

-- CreateIndex
CREATE INDEX "scenarios_organizationId_fiscalYear_kind_idx" ON "scenarios"("organizationId", "fiscalYear", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_assumptions_scenarioId_key_key" ON "scenario_assumptions"("scenarioId", "key");

-- CreateIndex
CREATE INDEX "risk_entries_organizationId_status_severity_idx" ON "risk_entries"("organizationId", "status", "severity");

-- CreateIndex
CREATE INDEX "risk_entries_nextReviewAt_idx" ON "risk_entries"("nextReviewAt");

-- CreateIndex
CREATE INDEX "control_entries_organizationId_kind_status_idx" ON "control_entries"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "control_entries_nextReviewAt_idx" ON "control_entries"("nextReviewAt");

-- CreateIndex
CREATE UNIQUE INDEX "corrective_actions_taskId_key" ON "corrective_actions"("taskId");

-- CreateIndex
CREATE INDEX "corrective_actions_organizationId_completedAt_idx" ON "corrective_actions"("organizationId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "managed_documents_currentVersionId_key" ON "managed_documents"("currentVersionId");

-- CreateIndex
CREATE INDEX "managed_documents_organizationId_category_visibility_idx" ON "managed_documents"("organizationId", "category", "visibility");

-- CreateIndex
CREATE INDEX "managed_documents_organizationId_expiresOn_idx" ON "managed_documents"("organizationId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_version_key" ON "document_versions"("documentId", "version");

-- CreateIndex
CREATE INDEX "knowledge_articles_organizationId_status_category_idx" ON "knowledge_articles"("organizationId", "status", "category");

-- CreateIndex
CREATE INDEX "knowledge_articles_nextReviewAt_idx" ON "knowledge_articles"("nextReviewAt");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_articles_organizationId_slug_key" ON "knowledge_articles"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "competitors_organizationId_nextReviewAt_idx" ON "competitors"("organizationId", "nextReviewAt");

-- CreateIndex
CREATE INDEX "market_insights_organizationId_kind_observedOn_idx" ON "market_insights"("organizationId", "kind", "observedOn");

-- CreateIndex
CREATE INDEX "market_insights_nextReviewAt_idx" ON "market_insights"("nextReviewAt");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_boards_supersededById_key" ON "analysis_boards"("supersededById");

-- CreateIndex
CREATE INDEX "analysis_boards_organizationId_kind_preparedOn_idx" ON "analysis_boards"("organizationId", "kind", "preparedOn");

-- CreateIndex
CREATE INDEX "analysis_entries_boardId_bucket_sortOrder_idx" ON "analysis_entries"("boardId", "bucket", "sortOrder");

-- CreateIndex
CREATE INDEX "meetings_organizationId_heldAt_idx" ON "meetings"("organizationId", "heldAt");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_participants_meetingId_userId_key" ON "meeting_participants"("meetingId", "userId");

-- CreateIndex
CREATE INDEX "report_schedules_organizationId_active_nextRunAt_idx" ON "report_schedules"("organizationId", "active", "nextRunAt");

-- CreateIndex
CREATE INDEX "report_runs_organizationId_kind_periodStart_idx" ON "report_runs"("organizationId", "kind", "periodStart");

-- CreateIndex
CREATE INDEX "tasks_objectiveId_idx" ON "tasks"("objectiveId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "investments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "risk_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "control_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "knowledge_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_definitions" ADD CONSTRAINT "kpi_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_targets" ADD CONSTRAINT "kpi_targets_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "kpi_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_snapshots" ADD CONSTRAINT "kpi_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_snapshots" ADD CONSTRAINT "kpi_snapshots_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "kpi_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_snapshots" ADD CONSTRAINT "health_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_kpiDefinitionId_fkey" FOREIGN KEY ("kpiDefinitionId") REFERENCES "kpi_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_result_checkins" ADD CONSTRAINT "key_result_checkins_keyResultId_fkey" FOREIGN KEY ("keyResultId") REFERENCES "key_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_result_checkins" ADD CONSTRAINT "key_result_checkins_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "budget_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investments" ADD CONSTRAINT "investments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investments" ADD CONSTRAINT "investments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investments" ADD CONSTRAINT "investments_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_assumptions" ADD CONSTRAINT "scenario_assumptions_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_entries" ADD CONSTRAINT "risk_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_entries" ADD CONSTRAINT "risk_entries_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_entries" ADD CONSTRAINT "control_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_entries" ADD CONSTRAINT "control_entries_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "risk_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "control_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_documents" ADD CONSTRAINT "managed_documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_documents" ADD CONSTRAINT "managed_documents_subjectEmployeeId_fkey" FOREIGN KEY ("subjectEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_documents" ADD CONSTRAINT "managed_documents_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_documents" ADD CONSTRAINT "managed_documents_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "managed_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "file_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_insights" ADD CONSTRAINT "market_insights_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_boards" ADD CONSTRAINT "analysis_boards_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_boards" ADD CONSTRAINT "analysis_boards_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "analysis_boards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_entries" ADD CONSTRAINT "analysis_entries_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "analysis_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "report_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "file_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

