import * as z from "zod";
import { isApproved } from "./approval.js";
import { ADMIN_INBOX, sendAccessRequest, sendAuthEmail } from "./email.js";
import type { Env } from "./types";

export function isOperator(user: { email: string; emailVerified: boolean }): boolean {
  return user.emailVerified && user.email.toLowerCase() === ADMIN_INBOX.toLowerCase();
}

export async function hasPendingInvitation(env: Env, email: string): Promise<boolean> {
  const invitation = await env.DB.prepare(
    `SELECT id FROM invitation
     WHERE lower(email) = ? AND status = 'pending'
       AND julianday(expiresAt) > julianday('now')
     UNION ALL
     SELECT id FROM individual_invitation
     WHERE lower(email) = ? AND acceptedAt IS NULL
       AND julianday(expiresAt) > julianday('now') LIMIT 1`,
  ).bind(email.trim().toLowerCase(), email.trim().toLowerCase()).first<{ id: string }>();
  return invitation !== null;
}

const emailAddress = z.email().transform((email) => email.toLowerCase());

// Better Auth requires the sender to be a member when reading an invitation.
// The operator provisions empty teams without joining them.
export async function getOperatorTeamInvitation(env: Env, id: string, email: string) {
  const invitation = await env.DB.prepare(`
    SELECT i.id, i.email, i.role, i.organizationId, i.inviterId, i.status,
           i.expiresAt, i.createdAt, o.name AS organizationName,
           o.slug AS organizationSlug, u.email AS inviterEmail
    FROM invitation i
    JOIN organization o ON o.id = i.organizationId
    JOIN user u ON u.id = i.inviterId
    JOIN user_approval a ON a.userId = u.id AND a.approvedAt IS NOT NULL
    WHERE i.id = ? AND lower(i.email) = ? AND i.role = 'owner'
      AND i.status = 'pending' AND julianday(i.expiresAt) > julianday('now')
      AND lower(u.email) = ? AND u.emailVerified = 1
      AND NOT EXISTS (SELECT 1 FROM member m WHERE m.organizationId = i.organizationId)
  `).bind(id, email.toLowerCase(), ADMIN_INBOX.toLowerCase()).first<{
    id: string; email: string; role: string; organizationId: string; inviterId: string;
    status: string; expiresAt: string; createdAt: string;
    organizationName: string; organizationSlug: string; inviterEmail: string;
  }>();
  return invitation;
}

const operatorInvite = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("individual"), email: emailAddress }),
  z.object({ kind: z.literal("manager"), email: emailAddress, teamName: z.string().trim().min(1).max(80) }),
]);

const accessRequest = z.object({
  name: z.string().trim().min(1).max(200),
  email: emailAddress,
  kind: z.enum(["individual", "team"]),
  company: z.string().trim().max(200).optional(),
  teamSize: z.string().trim().max(100).optional(),
  message: z.string().trim().max(4000).optional(),
});

export async function handleRequestAccess(req: Request, env: Env): Promise<Response> {
  const parsed = accessRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter your name, a valid email and whether you need individual or team access." }, { status: 400 });
  const result = await sendAccessRequest(env, parsed.data);
  return Response.json(result.ok ? { ok: true } : { error: "Could not send your request. Please try again." }, { status: result.ok ? 200 : 503 });
}

export async function handleCreateInvitation(
  req: Request, env: Env, user: { id: string; email: string; emailVerified: boolean },
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (!isOperator(user) || !(await isApproved(env, user.id))) {
    return json({ error: "Only the operator can invite individuals or managers of new teams." }, 403);
  }
  const parsed = operatorInvite.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Choose an invitation type and enter a valid email. Team managers also need a team name of up to 80 characters." }, 400);
  const invitation = parsed.data;
  const { email } = invitation;
  const invitationId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  const url = new URL("/", env.BETTER_AUTH_URL);
  let description: string;
  let subject: string;
  if (invitation.kind === "manager") {
    const organizationId = crypto.randomUUID();
    // The operator does not join this team. Its first member is the invited owner.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organization (id, name, slug, metadata, createdAt) VALUES (?, ?, ?, ?, ?)`)
        .bind(organizationId, invitation.teamName, "team-" + organizationId, JSON.stringify({ plan: "team" }), now.toISOString()),
      env.DB.prepare(`INSERT INTO invitation (id, organizationId, email, role, status, inviterId, expiresAt, createdAt)
        VALUES (?, ?, ?, 'owner', 'pending', ?, ?, ?)`)
        .bind(invitationId, organizationId, email, user.id, expiresAt, now.toISOString()),
    ]);
    url.searchParams.set("invitation", invitationId);
    subject = "You're invited to manage a team on clocked";
    description = `You're invited to manage ${invitation.teamName} on clocked. Accept your invitation to open your own team and invite your workers.`;
  } else {
    await env.DB.prepare(`INSERT INTO individual_invitation (id, email, inviterId, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)`)
      .bind(invitationId, email, user.id, now.toISOString(), expiresAt).run();
    url.searchParams.set("individualInvitation", invitationId);
    subject = "You're invited to clocked";
    description = "You're invited to use clocked as an individual. Track your own time and manage your timesheets and email delivery without a team. You can join a team later.";
  }
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const sent = await sendAuthEmail(env, {
    to: email,
    subject,
    text: `${description}\n\n${url}\n\nThis invitation expires in 7 days. Use this email address to sign in or create your account.`,
    html: `<p>${escapeHtml(description)}</p><p><a href="${escapeHtml(url.toString())}">Accept invitation</a></p><p>This invitation expires in 7 days. Use this email address to sign in or create your account.</p>`,
  });
  // Always return the saved link, including when the email provider fails.
  return json({ url: url.toString(), emailSent: sent.ok, expiresAt });
}

export async function handleAcceptIndividualInvitation(
  req: Request, env: Env, user: { id: string; email: string; emailVerified: boolean },
): Promise<Response> {
  if (!user.emailVerified) return Response.json({ error: "Verify your email before accepting the invitation." }, { status: 403 });
  const parsed = z.object({ invitationId: z.uuid() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid invitation." }, { status: 400 });
  const { invitationId } = parsed.data;
  const email = user.email.toLowerCase();
  const invitation = await env.DB.prepare(
    `SELECT acceptedAt, acceptedBy, julianday(expiresAt) > julianday('now') AS valid
     FROM individual_invitation WHERE id = ? AND lower(email) = ?`,
  ).bind(invitationId, email).first<{ acceptedAt: string | null; acceptedBy: string | null; valid: number }>();
  if (!invitation || (invitation.acceptedAt ? invitation.acceptedBy !== user.id : !invitation.valid)) {
    return Response.json({ error: "This invitation is invalid, expired, or was sent to another email address." }, { status: 403 });
  }
  if (!invitation.acceptedAt) {
    // D1 batches are transactional. Approval and single-use acceptance commit together.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user_approval (userId, requestedAt, approvedAt)
        SELECT ?, datetime('now'), datetime('now') FROM individual_invitation
        WHERE id = ? AND lower(email) = ? AND acceptedAt IS NULL AND julianday(expiresAt) > julianday('now')
        ON CONFLICT(userId) DO UPDATE SET approvedAt = COALESCE(user_approval.approvedAt, excluded.approvedAt)`)
        .bind(user.id, invitationId, email),
      env.DB.prepare(`UPDATE individual_invitation SET acceptedAt = datetime('now'), acceptedBy = ?
        WHERE id = ? AND lower(email) = ? AND acceptedAt IS NULL AND julianday(expiresAt) > julianday('now')`)
        .bind(user.id, invitationId, email),
    ]);
  }
  const accepted = await env.DB.prepare("SELECT acceptedBy FROM individual_invitation WHERE id = ? AND acceptedAt IS NOT NULL")
    .bind(invitationId).first<{ acceptedBy: string | null }>();
  if (accepted?.acceptedBy !== user.id) return Response.json({ error: "This invitation has expired." }, { status: 403 });
  return Response.json({ ok: true });
}
