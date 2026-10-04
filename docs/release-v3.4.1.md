TrPTools v3.4.1

Security, performance and usability audit: 19 findings fixed across the API,
frontend and Discord bot. The full finding log and validation are recorded in
backend/docs/audit-2026-10-03.md.

Security
- Enforce API-key scopes centrally, keep account and elevation operations browser-only,
  enforce parent visibility, and revoke dispatch streams when access expires.
- Use socket IPs for Bun rate limits unless a trusted proxy is explicitly configured.
- Refuse the development encryption key in production; patch vulnerable dependencies.
- Validate policy redirects and preserve moderator approvals during report races.

Performance and reliability
- Bound dispatch regex matching with RE2JS and limit recurrence expansion.
- Add transport deadlines, guard overlapping bot polling, batch moderation reads,
  and fetch independent status data in parallel.
- Serialize competing signup writes and preserve reservations on failed Discord moves.
- Clean up failed media uploads and validate media/owner identifiers.

Usability
- Associate field labels, help and errors with their controls; label dialogs and mobile menus.
- Give galleries native dialog focus, Escape handling and focus restoration.
- Report failed settings/logout requests accurately and batch/retry imported owner profiles.

Upgrade
- In each Cloudflare Worker's Settings > Build > Build Variables and Secrets, set
  BUN_VERSION=1.4.2 and retry. This must precede the automatic dependency install;
  Cloudflare does not read .bun-version and its default Bun cannot read lockfile v3.
- Apply backend migration 0036_signup_guards before serving the updated API.
  Docker startup applies migrations automatically; historical signups are preserved.
- Keep the current private ENCRYPTION_KEY. Installations using the development key
  must re-encrypt stored credentials before replacing it.
- Leave TRUST_PROXY_HEADERS=false for direct Bun deployments; enable it only behind
  a trusted proxy that replaces IP headers and blocks direct API access.
- API integrations require matching scopes. Recurrence rules must be hourly or slower;
  regexes using backreferences or lookahead may need rewriting for RE2.

Validation
- 319 core tests passed, plus native/edge Redis dispatch integration, isolated
  PostgreSQL/HTTP concurrency and storage fixtures, browser accessibility/mobile checks,
  Node/Worker builds and workerd smoke checks.
- All three dependency audits reported zero known vulnerabilities.
- Full Compose runtime validation was unavailable because the local Docker daemon
  was stopped. Production provider behavior and infrastructure were not tested.
