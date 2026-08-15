# TrP Tools API

The backend for TrP Tools 2.0. ElysiaJS on Bun, Postgres via Drizzle, and
Valkey/Redis for caching, dispatch room state and realtime fan-out.

## Running locally

```bash
cp .env.example .env      # fill in ENCRYPTION_KEY and the Roblox app credentials
bun install
bun run db:migrate
bun run dev
```

The API listens on `http://localhost:3001`. Interactive documentation is served
at `/docs`.

Postgres, Valkey and MinIO come from the compose file one directory up:

```bash
docker compose up -d postgres valkey minio minio-init
```

### Working without Roblox credentials

Roblox OAuth needs a registered app and a browser round trip, which is awkward
when you only want to work on a screen. The seed creates a group, routes,
depots, shifts and a signed-in session:

```bash
bun run db:seed
```

It prints a session token. Set it as an `access_token` cookie on the API origin
and you are signed in as a site admin.

## Layout

Each domain owns a `controller` (routes and schemas), a `service` (the actual
work) and a `model` (request and response types). Subdomains nest.

```
src/
  auth/          Roblox OAuth, sessions, API keys
  users/         Profiles, preferences, route preferences
  groups/        Registration, settings, visibility
    rank/        Roblox role → permission mapping
    routes/      Custom routes and depots
  schedule/      Recurring shifts, occurrences, signups
  rooms/         Dispatch room lifecycle
    dispatch/    Live vehicle state, SSE, automatic assignment
  public/        Anonymous reads of published pages
  media/         Image uploads to object storage
  reports/       Reporting and the site admin portal
  tools/         Stage programmer storage
  db/            Drizzle schema, split by domain
  utils/         Cross-cutting concerns
```

## How Roblox access works

Roblox has moved group and user reads to **Open Cloud v2**, which rejects
anonymous requests. Membership is read with
`GET /cloud/v2/groups/{id}/memberships?filter=user == 'users/{id}'`.

The catch is rate limits. A single OAuth authorization is capped at 30
requests/minute for `GetGroup` and 90/minute for roles and memberships, while an
API key owner gets 150 and 300. TrP Tools resolves a permission level on nearly
every request, so a user's own token cannot carry that load.

Credentials are therefore tried in order (`src/utils/roblox.ts`):

1. **The group's own Open Cloud API key.** Highest limits, and it works when
   nobody is signed in. Group owners add one in group settings; it is verified
   against their group and stored AES-GCM encrypted.
2. **An instance-wide API key**, if the operator sets `ROBLOX_API_KEY`.
3. **The requesting user's OAuth token**, which carries the `group:read` scope.
4. **The legacy endpoints**, so a group can onboard before wiring up a key.

Every response is cached in Redis, and permission levels are cached for a
minute. A busy dispatch room costs a couple of Roblox calls per minute rather
than hundreds.

## Authentication

- **Users** sign in with Roblox OAuth. The session token is random, and only its
  SHA-256 hash is stored. Cookies are `HttpOnly`, `Secure` when the API is
  served over https, and `SameSite=None` because the site and API are separate
  origins.
- **Integrations** send `Authorization: Bearer <key>`. Keys are scoped, hashed
  at rest, and shown exactly once at creation.
- Mutating requests are rejected when they carry an `Origin` outside
  `FRONTEND_URL`, which is what stops a third-party page from riding the
  session cookie.

## Permissions

Permission always derives from the Roblox role the user currently holds, mapped
through the group's rank bindings. Nothing is stored that Roblox does not still
back, so a demotion in the Roblox group takes effect within a minute.

| Level | Name     | Can                                            |
| ----- | -------- | ---------------------------------------------- |
| 0     | None     | Nothing                                        |
| 1     | Dispatch | Join a dispatch room and assign routes         |
| 2     | Host     | Open and close dispatch rooms                  |
| 3     | Manage   | Ranks, routes, shifts, settings                |

The Roblox owner role is pinned to level 3 and cannot be demoted through the
API, so a group cannot lock itself out.

## Realtime

Dispatch updates fan out over Redis pub/sub and reach clients as server-sent
events on `GET /dispatch/:roomId/connect`. The stream opens with a `SYNC` frame
carrying the whole vehicle list, which makes reconnection self-healing: a client
that drops does not need to replay anything.

## Depots and routes

Every group is seeded with what the game itself has:

- **Depots 1 (Main Island) and 2 (Cat Island).** Depots are identified by their
  number.
- **Routes 6, 9, 10, 14 and 16**, marked `builtIn`. They can be recoloured,
  reshaped, re-shared and disabled, but never renamed or deleted — a group that
  removed one would have no way to get it back.

Depot 1 serves 10, 14 and 16; depot 2 serves 6, 9 and 10, matching the legacy
spawn table. Both depots and routes accept descriptions and uploaded images,
which appear on the group's public page.

## Automatic route assignment

`src/rooms/dispatch/solver.ts`. The legacy dispatcher hardcoded five route
numbers and a fixed depot table, which is exactly why custom routes were never
assignable. Here the eligible set comes from the database: a route declares
which depots it serves and whether it accepts automatic assignment.

Routes carry a **target share** — the percentage of vehicles they should hold —
rather than a hard cap. Shares are normalised across whichever routes a given
vehicle's depot actually reaches, so they never have to total 100 and a depot
served by two routes still splits evenly between them.

Assignment prefers routes the driver marked as a favourite, then routes they
have no opinion about, then ones they dislike. Within a tier it picks whichever
route is furthest below its target share, breaking ties randomly.

## Images

Uploads go to S3-compatible object storage through Bun's built-in S3 client, so
MinIO, Garage, R2 and AWS all work unchanged. The compose file runs MinIO.

Files are validated by their magic number rather than the declared content
type, capped at 6MB, and limited to 12 per route or depot. Uploads are rate
limited per account.

## Moderation

Anything a group puts in front of the public — the group itself, routes, depots
and images — can be reported by any signed-in user.

Filing a report hides the target **immediately**. Waiting for a human would
leave abusive images in front of the public for as long as it takes an admin to
wake up. A site admin then either clears the content, which restores it and
exempts it from future automatic hiding, or upholds the report and it stays
down. The exemption matters: without it one persistent reporter could keep a
legitimate group suppressed indefinitely.

Reports are capped at 10 per account per hour, and a user cannot file two open
reports against the same thing.

Site admins (`SITE_ADMINS`, or `siteRank = 'admin'`) get `/admin/*`: an
overview, the report queue with a snapshot of each target and its images, and
the clear/uphold actions.

## Scripts

| Script            | Purpose                                |
| ----------------- | -------------------------------------- |
| `bun run dev`     | Watch mode                             |
| `bun run start`   | Run once                               |
| `bun run build`   | Bundle to `dist/`                      |
| `bun run typecheck` | Type check without emitting          |
| `bun run db:generate` | Generate a migration from the schema |
| `bun run db:migrate`  | Apply migrations                   |
| `bun run db:push` | Push the schema without a migration    |
| `bun run db:seed` | Seed development data                  |
| `bun run db:studio` | Browse the database                  |
