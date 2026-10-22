import { AwsClient } from "aws4fetch";

export interface EmailMessageInput {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: { filename: string; content: Uint8Array; contentType: string }[];
}

export interface EmailEnvironment {
  MAIL_FROM: string;
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  EMAIL?: SendEmail;
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  SES_SESSION_TOKEN?: string;
}

export type EmailResult =
  | { ok: true }
  | { ok: false; error: "email not configured" | "email send failed" };

interface EmailProvider {
  send(message: EmailMessageInput): Promise<void>;
}

function base64(content: Uint8Array): string {
  let binary = "";
  for (const byte of content) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function requireSuccess(response: Response): Promise<void> {
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
  await response.body?.cancel();
}

/** Provider-specific credentials and payloads stay behind this interface. */
function createEmailProvider(env: EmailEnvironment): EmailProvider {
  const from = `clocked <${env.MAIL_FROM}>`;
  if (!env.MAIL_FROM) throw new Error("MAIL_FROM is required");
  switch (env.EMAIL_PROVIDER ?? "resend") {
    case "resend": {
      const apiKey = env.RESEND_API_KEY;
      if (!apiKey) throw new Error("RESEND_API_KEY is required");
      return {
        async send(message) {
          await requireSuccess(await fetch("https://api.resend.com/emails", {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              from, to: message.to, subject: message.subject,
              text: message.text, html: message.html, reply_to: message.replyTo,
              attachments: message.attachments?.map((attachment) => ({
                filename: attachment.filename, content: base64(attachment.content),
                content_type: attachment.contentType,
              })),
            }),
          }));
        },
      };
    }
    case "cloudflare": {
      const binding = env.EMAIL;
      if (!binding) throw new Error("EMAIL send_email binding is required");
      return {
        async send(message) {
          const attachments = message.attachments?.map((attachment) => ({
            filename: attachment.filename, content: base64(attachment.content),
            type: attachment.contentType, disposition: "attachment",
          } satisfies EmailAttachment));
          // Separate submissions give each recipient its own delivery outcome.
          const results = await Promise.allSettled(message.to.map(async (recipient) => binding.send({
            from: { email: env.MAIL_FROM, name: "clocked" },
            to: [recipient], subject: message.subject, text: message.text,
            html: message.html, replyTo: message.replyTo,
            attachments,
          })));
          if (results.some((result) => result.status === "rejected")) {
            throw new Error("Cloudflare rejected an email submission");
          }
        },
      };
    }
    case "ses": {
      const region = env.SES_REGION;
      if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)
        || !env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY) {
        throw new Error("SES_REGION, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY are required");
      }
      const client = new AwsClient({
        accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY,
        sessionToken: env.SES_SESSION_TOKEN, service: "ses", region,
      });
      const suffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
      return {
        async send(message) {
          const request = await client.sign(`https://email.${region}.${suffix}/v2/email/outbound-emails`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              FromEmailAddress: from,
              Destination: { ToAddresses: message.to },
              ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
              Content: { Simple: {
                Subject: { Data: message.subject, Charset: "UTF-8" },
                Body: {
                  Text: { Data: message.text, Charset: "UTF-8" },
                  Html: message.html === undefined ? undefined : { Data: message.html, Charset: "UTF-8" },
                },
                Attachments: message.attachments?.map((attachment) => ({
                  FileName: attachment.filename, RawContent: base64(attachment.content),
                  ContentType: attachment.contentType, ContentDisposition: "ATTACHMENT",
                  ContentTransferEncoding: "BASE64",
                })),
              } },
            }),
          });
          // Send once. An ambiguous timeout must not automatically duplicate mail.
          await requireSuccess(await fetch(request, { signal: AbortSignal.timeout(15_000) }));
        },
      };
    }
    default:
      throw new Error("EMAIL_PROVIDER must be resend, cloudflare or ses");
  }
}

export async function sendEmail(env: EmailEnvironment, message: EmailMessageInput): Promise<EmailResult> {
  let provider: EmailProvider;
  try {
    provider = createEmailProvider(env);
  } catch (error) {
    console.error("email.configuration", { provider: env.EMAIL_PROVIDER ?? "resend", error: String(error) });
    return { ok: false, error: "email not configured" };
  }
  if (message.to.length === 0) return { ok: false, error: "email send failed" };
  try {
    await provider.send(message);
    return { ok: true };
  } catch {
    // Provider error bodies can contain addresses or authentication links.
    console.error("email.send_failed", { provider: env.EMAIL_PROVIDER ?? "resend" });
    return { ok: false, error: "email send failed" };
  }
}
