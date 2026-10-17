-- Step 18 · performance: indexes for the hot read paths found with EXPLAIN on the seed
-- (enable_seqscan off: these filters had no usable index). Indexes only — RLS / grants unchanged.

-- Retention held (receivables moneyOf / closeout), change-order billing lines (register, invoice hooks):
-- lines are looked up by their source, not by invoice.
CREATE INDEX IF NOT EXISTS "InvoiceLine_tenantId_sourceType_sourceId_idx" ON "InvoiceLine"("tenantId", "sourceType", "sourceId");

-- Schedule used quantities / quotas / material variance per milestone (Step 13 / 14).
CREATE INDEX IF NOT EXISTS "MaterialUsage_tenantId_milestoneId_idx" ON "MaterialUsage"("tenantId", "milestoneId");

-- Dashboard alerts and project billing events: open events of the visible projects.
CREATE INDEX IF NOT EXISTS "BillingEvent_tenantId_projectId_resolvedAt_idx" ON "BillingEvent"("tenantId", "projectId", "resolvedAt");
