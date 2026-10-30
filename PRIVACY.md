# Privacy Policy

**Effective date:** July 9, 2026

Clocked is an open-source Windows time-tracking application. This policy explains what data Clocked handles when you use the desktop app, the hosted Clocked service, or your own self-hosted Clocked Worker.

## Summary

- The desktop app records work sessions from Windows power, session, idle, and manual pause/resume events.
- Your local SQLite database is the source of truth and remains on your computer unless you enable synchronization.
- Cloud synchronization is optional. When enabled, the app sends session data to the Worker URL and account token that you configure.
- Clocked does not take screenshots, record keystrokes, inspect application contents, or sell personal data.
- A self-hosted Worker is operated by the person or organization that deployed it, not by the hosted Clocked service.

## Data handled by the Windows desktop app

The desktop app may store the following information locally in `%APPDATA%\clocked\data\`:

- Session identifiers.
- Session start and end timestamps.
- Start and end reasons, such as app start, unlock, lock, suspend, idle, activity, manual pause, or crash recovery.
- Configuration values, including your Worker URL, sync token, timezone-related settings, idle timeout, target hours, and working-hour preferences.
- Diagnostic logs used to troubleshoot application behavior.

The desktop app uses Windows keyboard and mouse idle duration only to determine whether the configured idle timeout has been reached. It does not record the keys pressed, mouse coordinates, typed content, screenshots, window contents, or browsing history.

## Optional synchronization

Clocked works in local-only mode without an account or network connection. Synchronization begins only after you configure a Worker URL and bearer token.

When synchronization is enabled, the desktop app sends session records over HTTPS to the configured Worker's `/sessions` endpoint. A synchronized record may include:

- Session ID.
- Start and end timestamps.
- Start and end reasons.

The bearer token identifies the account or self-hosted installation that receives the records. Treat this token like a password.

If you point Clocked at a third-party or self-hosted Worker, that operator controls how the synchronized data is stored, retained, secured, and used. Review that operator's privacy practices before enabling synchronization.

## Data handled by the hosted Clocked service

When you use the hosted service at `clocked.daviddusi.com`, the service may process:

- Account details, such as name, email address, password-derived authentication data, email-verification status, and login session data.
- Synced work-session records.
- Timesheet and delivery settings, including report recipients, report schedule, organization membership, and manually entered time adjustments.
- Subscription and organization status.
- Contact-sales submissions, including the information entered into the form.
- Basic operational and security data made available by Cloudflare, such as request timestamps, IP address, user agent, response status, and rate-limit state.

Passwords are handled by the authentication system and are not stored as readable plaintext.

## Payments

Paid subscriptions are processed by Stripe. Clocked may store Stripe identifiers and subscription status needed to provide access, but payment-card details are entered into and processed by Stripe rather than Clocked's application servers. Stripe's own privacy policy applies to its processing.

## Email delivery

Clocked may use Resend and Cloudflare email services to send account verification messages, reports, service messages, or contact-form notifications. The recipient address and message contents are shared with the applicable email provider for delivery.

## Cookies and authentication

The hosted dashboard uses authentication cookies or similar browser storage to keep you signed in, protect account access, and provide dashboard functionality. These are functional rather than advertising cookies.

## How data is used

Clocked processes data to:

- Record and synchronize work sessions.
- Display dashboards and generate timesheets.
- Deliver scheduled or manually requested reports.
- Authenticate users and protect accounts.
- Manage organizations, team access, and subscriptions.
- Diagnose failures, prevent abuse, and secure the service.
- Respond to support or sales inquiries.

Clocked does not sell personal data or use time-tracking records for targeted advertising.

## Data sharing

Data may be shared only as needed with infrastructure and service providers that operate the hosted service, including Cloudflare, Stripe, and Resend, or when required by law, necessary to protect users and the service, or involved in a business transfer.

A self-hosted deployment may use different providers chosen by its operator.

## Retention and deletion

Local desktop data remains on your computer until you remove it, uninstall the application, or delete the files yourself. Uninstalling may not remove your data directory automatically, allowing you to preserve or manually delete your records.

Hosted data is kept while needed to provide the service, meet security and operational requirements, resolve disputes, and comply with legal obligations. Some backup or security records may remain for a limited period after deletion.

To request access to or deletion of hosted account data, open a privacy request through the repository's GitHub Issues page and avoid posting sensitive information publicly. The maintainer can provide a private contact channel for account verification. You may also delete local records directly from your computer.

## Security

Clocked uses HTTPS for hosted synchronization and limits access using account sessions or bearer tokens. No system can guarantee absolute security. Keep your sync token private, use a unique password, enable available account protections, and rotate the token if it may have been exposed.

## Children

Clocked is intended for workplace and personal productivity use and is not directed to children under 13.

## International processing

The hosted service and its providers may process information in countries other than your own. Applicable safeguards and provider terms govern those transfers.

## Open-source software and forks

The source code is published under the MIT License. Anyone may run a modified copy or fork. This policy applies to the official hosted Clocked service and the unmodified desktop application's behavior as described here. It does not govern unrelated forks, modified builds, or third-party deployments.

## Changes to this policy

This policy may be updated as Clocked changes. Material revisions will be committed to the public repository with a new effective date.

## Contact

For privacy questions about the official hosted service, contact the project maintainer through the Clocked GitHub repository. Do not include passwords, bearer tokens, or sensitive timesheet data in a public issue.
