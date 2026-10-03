# Hosting panel regression verification — October 2, 2026

This fixes the reported hosting issues in the working checkouts of the backend,
frontend, bot and English locale sources. No release or deployment was made.
The reported deployment is 3.3.2 on Workers, Upstash, Neon and R2.

## Findings and changes

| Reported behavior | Change and evidence |
| --- | --- |
| Successful mutations followed by Bad Request | Every hosting route now explicitly awaits its asynchronous service. A source-preserving Elysia regression reproduces a committed extension followed by response-validation failure with the old multiline callback, and succeeds with the new callback. Response-validation errors are now server errors; malformed requests remain 400. Notes, ack, activation, rescheduling, extension and upload all return 200 in the session tests. |
| Discord or another host handles a card but the panel stays stale | Successful HTTP snapshots are applied immediately, SSE publishes atomic revisions, and older or previous-room frames are rejected. Successful `/staff-begin` now records its action through the internal API, which publishes the new state. Equivalent ISO timestamp representations are normalized. |
| Editing information changes the advance notice | Refreshes edit only existing public/staff opening announcements, without creating new messages or pinging again. The advance notice stays unchanged. |
| Cannot edit the join code | The panel and Discord modal edit the shared occurrence code. Omitted fields from old modals and image uploads preserve the code and visibility; blank codes remove it. |
| Hide the code in the public begin text | The occurrence can override the group's public-code setting. Staff text still contains the code. As the existing setting describes, the public join button still carries it in the link. |
| Panel begin fails | The real activation → lease → bot consumer → completion path now passes. Expanded testing also reproduced a Worker-only dispatch-board 500: Satori's default build compiled embedded Yoga WebAssembly at runtime. The standalone build now imports Yoga as a precompiled module. The board renders a valid PNG in both runtimes and returns 304 for its current ETag. |
| Extensions and time changes report errors | Session tests verify successful responses, live synchronization, twelve concurrent extensions accumulating correctly, and the saved recurring-event duration remaining unchanged. |
| Additional races | A monotonic refresh counter prevents two edits in the same millisecond from losing the second refresh. Live changes preserve another host's unsaved form draft. The panel updates from HTTP responses when its live stream is unavailable. |

The callback-format failure is reproducible, but the deployed 3.3.2 artifact and
production logs were not available. Ordinary Bun and minified Wrangler builds
of the old callbacks did not reproduce all of the original 400s, because their
formatting can change Elysia's Promise inference. The explicit async fix removes
that dependency. The renderer failure was reproduced directly in workerd.

Satori documents its standalone build for runtimes that disallow dynamic Wasm
loading in [its README](https://github.com/vercel/satori#standalone-build-of-satori).
Cloudflare describes importing compiled modules in
[its WebAssembly documentation](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/).

## Verification performed

- Backend typecheck, 194 source tests, 11 controller/dashboard tests, Bun build,
  Worker bundle dry run and actual workerd startup/rate-limit smoke passed.
- Sixteen real Redis Lua tests passed, including 1,500 deterministic randomized
  timeline operations, schema validation, concurrent extensions, leases,
  empty arrays, permissions, expiration and same-millisecond refreshes
  (1,339 assertions).
- The HTTP session suite passed 52 counted checks per runtime (156 total):
  native Bun, development workerd and minified production-mode workerd. It also
  checks real SSE delivery after mutations and bot actions. Invalid inputs do
  not change state; repeated handling returns 409; unknown events return 404;
  anonymous/viewer/dispatcher restrictions are enforced.
- Actual bot command/modal handlers and the panel's due-action consumer passed
  against native Bun and minified workerd. Completed actions do not repost on
  retry. Modal edits update the staff/public opening messages without touching
  the advance notice or re-pinging. PNG signatures and conditional caching pass.
- Bot typecheck and 73 tests passed with `.env` loading disabled. Worker bundle
  dry run passed. Actual bot workerd accepts a generated valid Discord signature
  and rejects a forged signature.
- Real Chromium with an ordinary host session passed: two hosts, note/code/owner
  edits, peer synchronization, preserved unsaved draft, stale frame rejection,
  extension, reschedule, acknowledgment, image upload/removal, and extension
  while SSE is blocked. Mutation responses are 200, there are no page errors,
  and no horizontal overflow at 320, 375, 768 or 1440 pixels. Mobile/desktop
  captures and the generated board were inspected.
- Frontend Svelte check has zero errors and warnings; 25 tests and the production
  Cloudflare build passed. English catalogues were regenerated and vendored.

Machine-readable session results are in
[host-regression-results.json](host-regression-results.json). Browser captures
are local generated artifacts under the frontend's
`output/playwright/host-regression/` directory.

## Runtime fidelity and limits

The session uses real workerd, real Postgres and real Valkey. Neon SQL HTTP and
Upstash REST/pubsub use local compatibility gateways. S3 uploads use a local
in-memory object gateway. Discord sends/edits are captured by a test client;
the real announcement, command, modal and automation code runs against the API.
The bot's Workers HTTP signature/interaction adapter is separately tested.

The host account is not elevated: group grants are placed in the ordinary
permission cache to avoid requiring a live Roblox identity. The session room is
an isolated fixture. Lua room opening/expiry behavior has separate tests.

No live guild posts, remote Neon/Upstash/R2 requests, Docker run, production CPU
measurements or deployed-session verification were performed in this follow-up.
Hosted-service authentication, remote network behavior and live Discord delivery
therefore still need a post-deployment session. These local passes do not claim
that the current production deployment has already changed.

## Repeat the session

Use only an isolated database named `trptools_hostfix` on port 55432 and Redis
on 56379. Apply the normal migrations and seed that database. The setup and HTTP
scripts refuse any other database name. Do not load production bot credentials.

1. Start backend `scripts/host-worker-gateway.ts` with
   `HOST_TEST_DATABASE_URL=postgresql://trptools@127.0.0.1:55432/trptools_hostfix`
   and `scripts/host-storage-gateway.ts` (port 53900).
2. Start the native backend on 53001 and `wrangler dev
   scripts/host-worker-entry.ts` on 53002 and 53004. Use `--minify` for 53004.
   Set Worker `DATABASE_URL` to the isolated database, Upstash URL to
   `http://127.0.0.1:56490`, its token to `local-hostfix`, service token to
   `local-host-verification-only`, frontend URL to `http://localhost:53000`,
   S3 endpoint to `http://127.0.0.1:53900`, public URL to
   `http://localhost:53900/trptools`, and both S3 keys to `hostfix`.
   Disable loading `.env` secrets in Wrangler with
   `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`. The native backend uses Redis
   `redis://127.0.0.1:56379` and the same local service/storage values.
3. Start the frontend on 53000 with both API URL variables pointing to 53004.
4. Run backend `bun run scripts/host-session-setup.ts`, then
   `bun run scripts/test-host-session.ts`.
5. Run bot `bun --no-env-file run scripts/test-host-session.ts`.
6. Run frontend `bun run scripts/test-host-session-ui.ts`. Set `CHROMIUM_PATH`
   if Chromium is installed elsewhere. Create a fresh fixture before repeating
   the sequence: the browser test acknowledges a card and cannot reuse it.

The helpers retain the fixture under `/tmp/trptools-hostfix-fixture.json` with
mode 0600. It contains a test session token and must not be published. The
machine-readable reports contain no session token. Temporary server processes
can be stopped once testing finishes.
