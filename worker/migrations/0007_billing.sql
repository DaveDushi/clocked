-- Stripe billing. One subscription per organization (solo subscribers get a
-- lightweight 1-seat personal org, so billing is uniformly org-scoped). The
-- authoritative plan still lives in organization.metadata.plan — the webhook
-- writes it there via setOrgPlan so the existing seat-cap logic "just works".
-- org_billing only holds the Stripe ids + status for the customer portal and
-- for mapping webhook events back to an org.
CREATE TABLE IF NOT EXISTS org_billing (
  organizationId       TEXT NOT NULL PRIMARY KEY,
  stripeCustomerId     TEXT,
  stripeSubscriptionId TEXT,
  status               TEXT,
  plan                 TEXT,
  currentPeriodEnd     INTEGER,
  updatedAt            INTEGER,
  FOREIGN KEY (organizationId) REFERENCES organization(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_billing_customer ON org_billing (stripeCustomerId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_billing_sub      ON org_billing (stripeSubscriptionId);

-- Webhook idempotency ledger: an event id we've already processed is a no-op.
CREATE TABLE IF NOT EXISTS stripe_events (
  id        TEXT NOT NULL PRIMARY KEY,
  createdAt INTEGER
);
