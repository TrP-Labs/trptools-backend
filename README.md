# trptools-backend

TrPTools API: Elysia, Drizzle, Postgres, and Redis. Runs on Bun in Docker or on Cloudflare Workers with Neon and Upstash REST.

## Development

1. Start infrastructure from the parent checkout: `docker compose up -d postgres valkey garage garage-init images`.
2. Run `cp .env.example .env` and fill in your credentials.
3. Run `bun install --frozen-lockfile && bun run db:migrate`.
4. Optionally run `bun run db:seed` for a demo group and session token.
5. Run `bun run dev`; the API listens on `http://localhost:3001` and docs are at `/docs`.

## Docker

1. Follow [trptools-deploy](https://github.com/TrP-Labs/trptools-deploy) for a server install.
2. To build locally, run `docker build -t trptools-backend .`.

The image applies migrations before starting. Set `DATABASE_URL`, `REDIS_URL`, public `BASE_URL`, allowed `FRONTEND_URL`, and a permanent `ENCRYPTION_KEY`; see [.env.example](./.env.example).

## Cloudflare Workers

1. Run `bun install --frozen-lockfile` and set your Worker name and domain in `wrangler.jsonc`.
2. Create a Neon database, an Upstash Redis database, and an R2 bucket with a public image domain.
3. Put credentials in Cloudflare secrets: `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ENCRYPTION_KEY`, `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`.
4. Set Worker variables `BASE_URL`, `FRONTEND_URL`, `COOKIE_DOMAIN`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_PUBLIC_URL`, and `S3_REGION=auto` for R2.
5. Run `DATABASE_URL=<Neon connection URL> bun run db:migrate` from your local environment.
6. Run `bun run check`, then `bun run worker:deploy` when you are ready.

Use `bunx wrangler secret put NAME` for each secret; local Worker development reads `.dev.vars`. The **Deploy Cloudflare Worker** GitHub workflow is also manual and uses the `production` environment's Cloudflare token and account ID; Workers do not run migrations on startup.

For Cloudflare Builds, use `bun install --frozen-lockfile` as the build command and `bun run worker:deploy` as the deploy command. Configure runtime secrets on the Worker and migrate the database before starting the build.

## Sign-in and storage

1. Create a [Roblox OAuth app](https://create.roblox.com/dashboard/credentials) with `openid`, `profile`, and `group:read`.
2. Register `<BASE_URL>/auth/callback` and set the client credentials.
3. For separate site/API subdomains, set `COOKIE_DOMAIN` to their shared parent (for example `.example.com`).

The API supports Garage, R2, and other S3 services; `S3_ENDPOINT` is for uploads and `S3_PUBLIC_URL` is the full browser-facing image base. Group Open Cloud keys are optional and must be user-owned.

## Discord (optional)

1. Set `DISCORD_APP_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, and `BOT_SERVICE_TOKEN`.
2. Register `<BASE_URL>/bot/callback` and `<BASE_URL>/auth/discord/callback` in Discord.
3. For a bot Worker, set `BOT_WORKER_URL` and `BOT_WORKER_SYNC_TOKEN` (matching the bot's `SYNC_TOKEN`).

## Checks

1. Run `bun run check` for types, unit tests, both bundles, and a local Worker health probe.
2. With Redis installed, run `bun run test:dispatch` to exercise both Redis clients.

MIT — see [LICENSE](./LICENSE).

### Browser shift reminders

Generate VAPID keys with `bun run scripts/generate-vapid.ts`, set
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, a real `VAPID_SUBJECT` contact, and a
random `BACKGROUND_JOB_TOKEN`. Keep the private key stable: changing it requires
browsers to subscribe again. Push subscriptions are encrypted with
`ENCRYPTION_KEY`; rotating it also requires re-enabling devices.

Workers runs the minute cron in `wrangler.jsonc`. Each of up to twenty due series
and each delivery is dispatched to a separate authenticated Worker request,
keeping encryption and recurrence out of page loads and bounding work per
invocation. The queue drains in batches of 25, with at most 15 chained batches
per cron run; remaining jobs wait for the next minute. `BASE_URL` must resolve to this Worker. Docker/Bun uses the same
planner and outbox from a minute timer in the API process. Multiple replicas are
safe: delivery leases and unique occurrence keys prevent ordinary duplicate
sends. A provider timeout after acceptance can cause a retry; browsers collapse
it using the occurrence notification tag.

Reminders arrive about ten minutes before a public shift starts. Following and
reminders are separate opt-ins; neither grants access to private shifts or staff
sheets. Push needs HTTPS (localhost works for development). iOS/iPadOS needs a
Home Screen install. Unconfigured instances show an explanatory disabled control.
Delivery retries are bounded to five attempts and fifteen minutes after the
occurrence starts; 404/410 removes an expired device. History is pruned after a
week. No notification job calls Roblox or Redis.


## Following, homepages, join links and statistics

Personal feeds use explicit group follows rather than Roblox group discovery.
Following is a reading preference and grants no access. User/host widget layouts
and optional instant join redirects are saved in account preferences; defaults
keep the join confirmation visible. Group managers configure a canonical Discord
invite and the Roblox join-link toggle through group settings.

Anonymous page counters are queued outside the response path and folded by the
minute background runner. Statistics requires VIEW_DASHBOARD. Route preference
breakdowns are aggregated with a five-vote minimum; built-in route preferences
remain global. Apply migrations through 0031 for these features.

See [engagement verification](docs/engagement-verification.md) for API/runtime
coverage, browser screenshots and the measured limits of the 10 ms CPU target.
