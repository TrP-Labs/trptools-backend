TrPTools v3.4.2

Correct Cloudflare Builds setup instructions across backend, frontend and bot.
Cloudflare's automatic dependency installation does not read .bun-version;
its default Bun 1.2.15 cannot parse the version-3 lockfiles shipped in v3.4.1.

Required build configuration
- Set BUN_VERSION=1.4.2 in each Worker's Settings > Build > Build Variables and Secrets.
- Apply the same setting to preview builds when enabled, then retry failed builds.
- This is a build variable, not a Wrangler runtime variable. It must be set before
  automatic dependency installation; changing the build command alone is insufficient.

The existing lockfiles and security dependency fixes are preserved. Frozen installs
were verified unchanged on Bun 1.4.2. GitHub Actions and Docker already use that pin.
The v3.4.1 audit log and upgrade notes now include the Cloudflare prerequisite.

This release publishes corrected repository documentation. It does not modify
Cloudflare dashboard settings; existing Wrangler credentials lack Workers CI access.
