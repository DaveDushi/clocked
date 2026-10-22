const SITE = "https://clocked.easytomanage.com";
const CONTACT = "ddusi@easytomanage.com";
const UPDATED = "October 22, 2026";

function legalPageResponse(page: "privacy" | "terms", content: string): Response {
  const title = page === "privacy" ? "Privacy policy" : "Terms of service";
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} | clocked</title>
<meta name="description" content="${title} for clocked desktop time tracking, cloud sync, teams, and Google sign-in." />
<link rel="canonical" href="${SITE}/${page}" />
<link rel="icon" href="/favicon.ico" />
<style>
  :root { color-scheme:dark; background:#0a0b10; color:#e9eaf0; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  * { box-sizing:border-box; }
  body { margin:0; font-size:17px; line-height:1.65; }
  .wrap { max-width:780px; margin:auto; padding:32px 24px 64px; }
  nav, footer { display:flex; flex-wrap:wrap; gap:12px 24px; }
  nav { margin-bottom:48px; }
  a { color:#f2a950; text-underline-offset:4px; }
  a:hover { color:#fff; }
  a:focus-visible { outline:2px solid #f2a950; outline-offset:5px; }
  h1 { margin:0; font-size:clamp(30px,6vw,44px); line-height:1.15; letter-spacing:-.03em; }
  h2 { margin:36px 0 10px; font-size:22px; line-height:1.3; }
  p { margin:12px 0; }
  li { margin:8px 0; }
  ul { padding-left:24px; }
  .updated { color:#b9becb; font-size:15px; margin:16px 0 28px; }
  footer { margin-top:48px; font-size:15px; }
  @media(max-width:480px) { .wrap { padding:24px 20px 48px; } nav { margin-bottom:36px; } }
</style>
</head>
<body>
<div class="wrap">
<nav aria-label="Main navigation"><a href="/">clocked home</a><a href="/privacy"${page === "privacy" ? ' aria-current="page"' : ""}>Privacy policy</a><a href="/terms"${page === "terms" ? ' aria-current="page"' : ""}>Terms of service</a></nav>
<main>
<h1>${title}</h1>
<p class="updated">Last updated: ${UPDATED}</p>
${content}
</main>
<footer><a href="/">Back to clocked</a><a href="mailto:${CONTACT}">Contact the operator</a><a href="/privacy/extension">Browser extension privacy</a></footer>
</div>
</body>
</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}

export function privacyPageResponse(): Response {
  return legalPageResponse("privacy", `
<p>This policy explains how clocked handles information when you use its desktop time tracker, browser companion, and hosted service at <a href="${SITE}">clocked.easytomanage.com</a>. The clocked operator is responsible for the hosted service and can be reached at <a href="mailto:${CONTACT}">${CONTACT}</a>. If you self-host, your hosting operator is responsible for that server's processing.</p>

<h2>Information we collect</h2>
<ul>
<li><strong>Account information.</strong> Your name, email address, email verification status, profile image if supplied, account identifiers, and sign-in records. For password accounts we store a password hash, not your plain-text password. Authentication records may include Google account identifiers and OAuth tokens.</li>
<li><strong>Time records.</strong> The desktop app stores sessions locally. When you connect cloud sync, we store session identifiers, start and end times, tracking reasons, timezones, and manual entries or edits.</li>
<li><strong>Optional project tracking.</strong> When enabled, the desktop app can attribute time to apps, website hostnames, and inferred project or document names. Cloud sync can upload daily app/project time totals. Full window-title capture is optional and off by default; raw window titles are not part of the cloud activity upload.</li>
<li><strong>Settings and teams.</strong> Device names and token records, working hours, inactivity rules, report schedules, report recipients, organization membership, roles, and invitations.</li>
<li><strong>Requests and diagnostics.</strong> Information you submit in access or support requests, and technical request information such as IP addresses and diagnostic logs used to operate and protect the service.</li>
</ul>
<p>Clocked does not capture screenshots, screen recordings, or keystroke content. The optional browser extension sends the active hostname and a short title to the desktop app on your computer. Read its <a href="/privacy/extension">separate privacy policy</a> for details.</p>

<h2>Google sign-in</h2>
<p>Google sign-in requests only basic identity permissions: openid, email, and profile. Google supplies your account identifier, name, email address, verification status, and profile picture if available. We use this information to authenticate you, create or link your clocked account, display your identity, and deliver account messages and timesheets. Google sign-in does not grant clocked access to your Gmail messages, Drive files, Calendar, or contacts.</p>
<p>We store Google identity information and authentication credentials in the hosted account database. We do not sell Google user data, use it for advertising, or use it to train AI models. Clocked's use and transfer of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements.</p>

<h2>How we use information</h2>
<p>We use information to authenticate accounts, sync time records, display dashboards and team reports, send requested or scheduled timesheets, manage invitations, respond to requests, and prevent abuse. Where data protection law requires a legal basis, we process information to provide the service you request, pursue legitimate interests in security and support, comply with legal obligations, or act on your consent where required.</p>

<h2>Who receives information</h2>
<p>Cloudflare hosts the service and its D1 database and processes requests and operational logs. Our configured email provider processes email addresses and message contents to deliver account mail, invitations, and timesheets. The hosted service currently uses Cloudflare Email Service; self-hosted installations can configure other providers.</p>
<p>If you join a team, authorized team owners and managers can see your name, email, membership information, and time records within the team's permitted scope. They can manage team policies, edit team time entries, and arrange report delivery. Timesheets go to recipients configured by you or an authorized manager. Your organization is responsible for its own use of employee information and for providing any workplace notices required by law.</p>
<p>The operator may access data as needed for support, security, and service administration. We may disclose information when legally required or necessary to protect users or the service. We do not sell personal information or share it for targeted advertising.</p>

<h2>Storage, security, and retention</h2>
<p>Local desktop data stays on your device unless you enable sync. Hosted data is stored using Cloudflare infrastructure, which may process information outside your country. Email providers and chosen recipients may also process data internationally. We use HTTPS for hosted connections, account authentication, and access controls. No storage or transmission method is completely secure.</p>
<p>We retain account information and synced records while needed to provide your account and time history, unless you delete them or request removal. Security logs, backups, and records needed for legal obligations may remain for their applicable operational or legal retention periods. Copies already delivered to email recipients are outside clocked's deletion controls.</p>

<h2>Your controls and requests</h2>
<p>You can pause tracking, disable project attribution, disconnect sync, revoke device tokens, and change report settings. Where available in your dashboard, use the data export and Delete cloud data controls. Deleting cloud data removes tracking records and revokes device tokens; it does not delete your sign-in account or the desktop database. Reconnecting sync may upload local records again.</p>
<p>To request deletion of your full account, including stored Google identity information and OAuth credentials, or request access or correction, email <a href="mailto:${CONTACT}">${CONTACT}</a> from your account address. We may verify your identity before acting. You can also revoke Google access through <a href="https://myaccount.google.com/connections">your Google Account connections</a>. Revoking access prevents future authorized Google access but does not itself delete records already stored by clocked.</p>
<p>Depending on your location, you may also have rights to object to processing, restrict processing, receive a portable copy, withdraw consent, or complain to your local data protection authority. Contact the operator to exercise applicable rights. For your organization's separate processing, contact your team administrator.</p>

<h2>Cookies and external services</h2>
<p>The website uses authentication cookies and browser storage for sign-in and interface preferences. It does not use advertising cookies. Some pages load fonts from Google Fonts, which receives the technical information needed to serve those requests. Google sign-in and links to GitHub or other external services are also subject to those services' own privacy policies.</p>

<h2>Children and policy changes</h2>
<p>Clocked is intended for adults and workplace use, and is not directed to children under 13. We will update this page and its date when practices change and provide additional notice or request consent when required before using data for a new purpose.</p>
`);
}

export function termsPageResponse(): Response {
  return legalPageResponse("terms", `
<p>These terms govern your use of the clocked hosted time-tracking service at <a href="${SITE}">clocked.easytomanage.com</a>, operated by the clocked project operator. Contact <a href="mailto:${CONTACT}">${CONTACT}</a> with questions. By creating an account or using the hosted service, you agree to these terms.</p>

<h2>The service</h2>
<p>Clocked records work sessions and offers optional cloud sync, dashboards, teams, and emailed timesheets. Access may require an invitation and account approval. The hosted service is currently free. Features, availability, and usage limits may change. Any future paid offering will require separate pricing and acceptance before charges apply.</p>

<h2>Your account</h2>
<p>Provide accurate account information, use only accounts you are authorized to access, and protect passwords and device tokens. Tell the operator if you suspect unauthorized access. You must be old enough to enter a binding agreement under applicable law. If you use clocked for an organization, you must have authority to act for it.</p>

<h2>Responsible use</h2>
<p>Do not use clocked unlawfully, monitor someone without required notice and authorization, access another user's records without permission, distribute malicious software, bypass access controls, or disrupt the service. Do not use invitations or report delivery to send unsolicited messages.</p>
<p>Team owners and managers are responsible for invitations, access permissions, working-hour policies, report recipients, and changes they make to team records. Organizations must comply with applicable employment and privacy laws and explain their use of clocked to team members.</p>

<h2>Your data and privacy</h2>
<p>You retain your rights to information you submit. You authorize clocked and its service providers to process it as needed to operate the features you use, including syncing records and sending reports to configured recipients. You are responsible for having permission to submit and share that information. Our <a href="/privacy">privacy policy</a> describes data handling and deletion options.</p>

<h2>Check your time records</h2>
<p>Automatic tracking can be incomplete or inaccurate because of device events, idle detection, configuration, connectivity, or software errors. Review and correct records before using them for payroll, billing, attendance decisions, or legal reporting. Keep independent copies of records you need. Clocked does not provide payroll, employment, tax, or legal advice.</p>

<h2>Availability and ending use</h2>
<p>We may maintain, change, or discontinue features, and may restrict or suspend accounts for abuse, security issues, legal requirements, or violations of these terms. Where practical, we will provide notice and an opportunity to export records before a planned shutdown. You can stop using the service at any time and request account deletion using the contact details in the privacy policy.</p>

<h2>Open-source software and third parties</h2>
<p>The clocked source code and desktop software are available under the <a href="https://github.com/DaveDushi/clocked/blob/main/LICENSE">MIT license</a>. These terms govern the hosted service and do not limit rights granted by that license. Google sign-in, email delivery, downloads, and other third-party services have their own terms and availability. A self-hosted server is operated by its own administrator.</p>

<h2>Warranties and liability</h2>
<p>To the extent permitted by applicable law, the hosted service is provided "as is" and "as available," without warranties of accuracy, uninterrupted availability, fitness for a particular purpose, or freedom from errors. To that same extent, the operator is not liable for indirect or consequential losses, lost profits, lost data, or losses arising from reliance on time records.</p>
<p>Nothing in these terms excludes liability that cannot lawfully be excluded, or limits mandatory consumer rights or other protections under applicable law.</p>

<h2>Changes and contact</h2>
<p>We may revise these terms as the service changes. We will update the date on this page and provide notice of material changes where required. Revised terms apply prospectively. If you disagree, stop using the hosted service and export or request deletion of your data. For questions or disputes, contact <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
`);
}
