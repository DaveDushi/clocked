// Stripe subscription billing. Everything is org-scoped: team/teamplus attach to
// the organization the owner manages; a solo "single" subscriber gets a
// lightweight 1-seat personal org (ensurePersonalOrg) so there is one billing
// model, one table (org_billing), one webhook path. The authoritative plan lives
// in organization.metadata.plan — the webhook writes it via setOrgPlan, so the
// existing membershipLimit/orgPlan seat-cap logic needs no changes.
//
// Workers specifics: the Stripe SDK must use the fetch HTTP client, and webhook
// signatures must be verified with the async SubtleCrypto path.
import Stripe from "stripe";

import { makeAuth } from "./auth-server";
import { orgPlan } from "./plans";
import type { Env } from "./types";

// The smallest tier; a canceled/lapsed subscription reverts an org to this.
const FLOOR_PLAN = "single";
const SELF_SERVE_PLANS = ["single", "team", "teamplus"] as const;
type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];

export function isSelfServePlan(plan: string): plan is SelfServePlan {
  return (SELF_SERVE_PLANS as readonly string[]).includes(plan);
}

/** Fresh Stripe client per request. apiVersion is omitted so the account default
 * is used (keeps us decoupled from the pinned SDK version). */
export function makeStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function priceForPlan(env: Env, plan: string): string | null {
  return plan === "single"
    ? env.STRIPE_PRICE_SINGLE
    : plan === "team"
      ? env.STRIPE_PRICE_TEAM
      : plan === "teamplus"
        ? env.STRIPE_PRICE_TEAMPLUS
        : null;
}

function planForPrice(env: Env, priceId: string): string | null {
  return priceId === env.STRIPE_PRICE_SINGLE
    ? "single"
    : priceId === env.STRIPE_PRICE_TEAM
      ? "team"
      : priceId === env.STRIPE_PRICE_TEAMPLUS
        ? "teamplus"
        : null;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Write organization.metadata.plan — the single source of truth every seat-cap
 * check reads. Merges into existing metadata so other keys are preserved. */
async function setOrgPlan(env: Env, orgId: string, plan: string): Promise<void> {
  const row = await env.DB.prepare("SELECT metadata FROM organization WHERE id = ?")
    .bind(orgId)
    .first<{ metadata: string | null }>();
  let meta: Record<string, unknown> = {};
  if (row?.metadata) {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      /* replace unparseable metadata */
    }
  }
  meta.plan = plan;
  await env.DB.prepare("UPDATE organization SET metadata = ? WHERE id = ?")
    .bind(JSON.stringify(meta), orgId)
    .run();
}

/** The org id for a Stripe customer, from a prior checkout. */
async function orgIdForCustomer(env: Env, customer: unknown): Promise<string | null> {
  if (typeof customer !== "string" || !customer) return null;
  const row = await env.DB.prepare("SELECT organizationId FROM org_billing WHERE stripeCustomerId = ?")
    .bind(customer)
    .first<{ organizationId: string }>();
  return row?.organizationId ?? null;
}

/** Ensure the user has a 1-seat personal org for the "single" plan, reusing an
 * existing one if present. Created via the better-auth server API so the owner
 * membership is set up exactly like a normal org. Idempotent: the slug is derived
 * from the user id, and we reuse any single-plan org the user already owns. */
export async function ensurePersonalOrg(
  env: Env,
  req: Request,
  user: { id: string; email: string },
): Promise<string> {
  const owned = await env.DB.prepare(
    `SELECT o.id AS id, o.metadata AS metadata
       FROM member m JOIN organization o ON o.id = m.organizationId
      WHERE m.userId = ? AND m.role LIKE '%owner%'`,
  )
    .bind(user.id)
    .all<{ id: string; metadata: string | null }>();
  for (const o of owned.results ?? []) {
    if (orgPlan(o.metadata) === "single") return o.id;
  }

  const local = user.email.split("@")[0] || "you";
  const slug = "personal-" + user.id.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24);
  const created = await makeAuth(env).api.createOrganization({
    body: { name: local + "'s workspace", slug, metadata: { plan: "single" } },
    headers: req.headers,
  });
  const orgId = (created as { id?: string } | null)?.id;
  if (!orgId) throw new Error("could not create personal organization");
  return orgId;
}

/** Create a Checkout Session for a plan and return its hosted URL. */
export async function createCheckoutSession(
  env: Env,
  opts: { orgId: string; plan: string; email: string; origin: string },
): Promise<string | null> {
  const price = priceForPlan(env, opts.plan);
  if (!price) return null;
  const stripe = makeStripe(env);
  const existing = await env.DB.prepare("SELECT stripeCustomerId FROM org_billing WHERE organizationId = ?")
    .bind(opts.orgId)
    .first<{ stripeCustomerId: string | null }>();
  const customerId = existing?.stripeCustomerId ?? undefined;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: opts.orgId,
    customer: customerId,
    customer_email: customerId ? undefined : opts.email,
    allow_promotion_codes: true,
    metadata: { orgId: opts.orgId, plan: opts.plan },
    subscription_data: { metadata: { orgId: opts.orgId, plan: opts.plan } },
    success_url: opts.origin + "/?billing=success",
    cancel_url: opts.origin + "/?billing=cancel",
  });
  return session.url;
}

/** Create a Billing Portal Session for an org's Stripe customer, or null if the
 * org has no customer yet. */
export async function createPortalSession(
  env: Env,
  opts: { orgId: string; origin: string },
): Promise<string | null> {
  const row = await env.DB.prepare("SELECT stripeCustomerId FROM org_billing WHERE organizationId = ?")
    .bind(opts.orgId)
    .first<{ stripeCustomerId: string | null }>();
  if (!row?.stripeCustomerId) return null;
  const stripe = makeStripe(env);
  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: opts.origin + "/",
  });
  return portal.url;
}

/** Verify + dispatch a Stripe webhook. Idempotent via the stripe_events ledger. */
export async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  if (!sig) return json({ error: "missing signature" }, 400);

  const stripe = makeStripe(env);
  const cryptoProvider = Stripe.createSubtleCryptoProvider();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch {
    return json({ error: "invalid signature" }, 400);
  }

  // Idempotency: if this event id is already recorded, it's a duplicate no-op.
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, createdAt) VALUES (?, ?)")
    .bind(event.id, Date.now())
    .run();
  if (ins.meta.changes === 0) return json({ received: true });

  try {
    await handleEvent(env, stripe, event);
  } catch (e) {
    // Roll back the ledger row so Stripe's retry can reprocess.
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
    return json({ error: "handler failed", detail: String(e) }, 500);
  }
  return json({ received: true });
}

async function handleEvent(env: Env, stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const orgId = s.client_reference_id ?? (s.metadata?.orgId as string | undefined);
      if (!orgId || !s.subscription) return;
      const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      await upsertBilling(env, orgId, sub);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const orgId =
        (sub.metadata?.orgId as string | undefined) ?? (await orgIdForCustomer(env, sub.customer));
      if (!orgId) return;
      await upsertBilling(env, orgId, sub);
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const orgId = await orgIdForCustomer(env, inv.customer);
      if (orgId) {
        // Keep the plan during Stripe's dunning grace; only mark the status.
        await env.DB.prepare("UPDATE org_billing SET status = 'past_due', updatedAt = ? WHERE organizationId = ?")
          .bind(Date.now(), orgId)
          .run();
      }
      break;
    }
    default:
      break;
  }
}

/** Persist the subscription's state and propagate the effective plan to
 * organization.metadata.plan (the source of truth for seat caps). */
async function upsertBilling(env: Env, orgId: string, sub: Stripe.Subscription): Promise<void> {
  const priceId = sub.items?.data?.[0]?.price?.id ?? "";
  const paidPlan = planForPrice(env, priceId);
  const active = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
  const effectivePlan = active && paidPlan ? paidPlan : FLOOR_PLAN;

  // current_period_end moved to the item level in newer API versions; read either.
  const s = sub as unknown as { current_period_end?: number };
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const periodEnd = s.current_period_end ?? item?.current_period_end ?? null;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  await env.DB.prepare(
    `INSERT INTO org_billing
       (organizationId, stripeCustomerId, stripeSubscriptionId, status, plan, currentPeriodEnd, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(organizationId) DO UPDATE SET
       stripeCustomerId = ?2, stripeSubscriptionId = ?3, status = ?4,
       plan = ?5, currentPeriodEnd = ?6, updatedAt = ?7`,
  )
    .bind(orgId, customerId, sub.id, sub.status, effectivePlan, periodEnd, Date.now())
    .run();

  await setOrgPlan(env, orgId, effectivePlan);
}
