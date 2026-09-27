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
