// Invite acceptance grants account access. Retain signed approval links and
// manual approval for accounts created before invite-only onboarding.

import { sendAuthEmail } from "./email.js";
import type { Env } from "./types";

export async function isApproved(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT approvedAt FROM user_approval WHERE userId = ?")
    .bind(userId)
    .first<{ approvedAt: string | null }>();
  return !!row?.approvedAt;
}

/** Mark a user approved. Returns true if they were not approved before. */
export async function approveUser(env: Env, userId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO user_approval (userId, requestedAt, approvedAt)
     VALUES (?, datetime('now'), datetime('now'))
     ON CONFLICT(userId) DO UPDATE SET approvedAt = excluded.approvedAt
     WHERE user_approval.approvedAt IS NULL`,
  )
    .bind(userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

async function approvalSig(env: Env, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("approve:" + userId));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function checkApprovalSig(env: Env, userId: string, sig: string): Promise<boolean> {
  if (!userId || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const want = await approvalSig(env, userId);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** Tell a user their account is ready. */
export async function sendApprovedEmail(env: Env, email: string): Promise<void> {
  const url = env.BETTER_AUTH_URL.replace(/\/$/, "") + "/";
  await sendAuthEmail(env, {
    to: email,
    subject: "Your clocked account is ready",
    text: `Your clocked account has been approved. Sign in to get your desktop sync token:\n\n${url}`,
    html: simpleEmailHtml(
      "You're in",
      "Your clocked account has been approved. Sign in to get your desktop sync token.",
      url,
      "Open clocked",
    ),
  });
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function simpleEmailHtml(title: string, body: string, url: string, cta: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f0f1f3;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">
    <tr><td style="padding:28px">
      <div style="font-size:22px;font-weight:700;color:#111827">${esc(title)}</div>
      <p style="font-size:14px;color:#4b5563;line-height:1.6">${esc(body)}</p>
      <p style="margin:24px 0"><a href="${esc(url)}" style="display:inline-block;background:#f2a950;color:#221503;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px">${esc(cta)}</a></p>
    </td></tr>
  </table></body></html>`;
}

/**
 * GET shows a confirm page and POST approves. Email link scanners follow GET
 * links, so a GET must never approve on its own.
 */
export async function handleAdminApprove(req: Request, env: Env, url: URL): Promise<Response> {
  const html = (title: string, body: string, status = 200) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f0f1f3;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
<h1 style="font-size:20px;margin:0 0 12px;color:#111827">${esc(title)}</h1>${body}</div></body></html>`,
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );

  let userId = url.searchParams.get("u") ?? "";
  let sig = url.searchParams.get("sig") ?? "";
  if (req.method === "POST") {
    const form = await req.formData().catch(() => null);
    userId = String(form?.get("u") ?? "");
    sig = String(form?.get("sig") ?? "");
  }
  if (!(await checkApprovalSig(env, userId, sig))) {
    return html("Link not valid", "<p>This approve link is broken or was changed.</p>", 403);
  }
  const user = await env.DB.prepare("SELECT email FROM user WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>();
  if (!user) return html("Account not found", "<p>This account no longer exists.</p>", 404);

  if (req.method === "POST") {
    if (await approveUser(env, userId)) await sendApprovedEmail(env, user.email);
    return html("Approved", `<p>${esc(user.email)} can now use clocked. We emailed them.</p>`);
  }
  if (await isApproved(env, userId)) {
    return html("Already approved", `<p>${esc(user.email)} already has access.</p>`);
  }
  return html(
    "Approve signup?",
    `<p style="color:#4b5563">${esc(user.email)} is waiting for access.</p>
<form method="post" action="/admin/approve">
<input type="hidden" name="u" value="${esc(userId)}"><input type="hidden" name="sig" value="${esc(sig)}">
<button style="background:#f2a950;color:#221503;border:0;font-weight:600;padding:12px 18px;border-radius:10px;font-size:15px;cursor:pointer">Approve</button>
</form>`,
  );
}
