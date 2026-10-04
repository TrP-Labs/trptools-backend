TrPTools v3.4.3

Fix Cloudflare Builds failing before compilation with "Unknown lockfile version".
Version-3 lockfiles introduced by v3.4.1's nested security overrides could not be
read by Cloudflare's default Bun 1.2.15. v3.4.2 only documented a version override.
This release restores repository compatibility without requiring dashboard changes.

- Upgrade Wrangler to 4.147.0, whose Miniflare already uses patched undici 7.29.1.
- Remove nested overrides; use flat cookie 1.1.1 and esbuild 0.28.1 security overrides.
- Regenerate version-1 lockfiles and preserve the bot's undici 6.28.1 dependency.
- Validate frozen installs and unit tests with Bun 1.2.15 in publication and manual
  Worker CI before using the pinned Bun 1.4.2 runtime.
- Replace a frontend test's unsupported Bun.JSONC call with TypeScript's JSONC parser.
- Check language-cookie writes/deletes alongside session parsing in the Worker smoke test.

Validation: all three frozen installs pass unchanged with Bun 1.2.15 and 1.4.2;
all three audits report zero known vulnerabilities. All Worker build/runtime paths
pass under Bun 1.2.15; Drizzle configuration checks pass with the esbuild override.
The release script additionally runs the complete pinned-runtime release gates.

Cloudflare BUN_VERSION=1.4.2 remains optional for toolchain alignment. No production
provider configuration or data is changed by this repository compatibility fix.
