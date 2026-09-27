# Host feature verification

All repositories remain on `dev`. No release, remote deployment, Discord command registration, or live Discord messages were made.

## Behavior and permissions

The Host preset opens Host above Dispatch. Hosts and dispatchers share one room and vehicle list. Opening pins an exact occurrence; extensions, announcement edits, and timeline overrides affect that occurrence only. An empty room expires at its end plus 30 minutes. Connected staff keep it open, and the final departure closes an inactive room. Active-window closure asks for the separate Close room grant; the Host preset does not include it, while Administrator includes it.

The saved Settings → Schedule controls new rooms and automation before any room opens. The default staff/public/complete events also respect their corresponding bot feature and automation switches. The depot reminder has its own toggle and minutes-before-end field. Custom reminders can target hosts, dispatchers, or both. Pending end-relative events move when the end is extended; handled history stays fixed.

Bot actions use two-minute leases. Successful delivery records whether automation or staff triggered the action; a failure releases it for retry. Early reminders remain visible until acknowledged. Announcement refresh revisions keep a later edit from being consumed by an earlier delivery. Completion does not close the hosting room or switch to the next shift.

Images are checked by size and magic bytes. Discord modal attachments are copied from allowlisted Discord attachment URLs into object storage, so signed URLs do not expire in announcements. Existing announcement edits suppress additional mentions and use the channel the original message was posted in.

## Checks

- Backend: typecheck, 161 pure/source tests, 9 dashboard integration tests, native build, Worker bundle dry run and real workerd initialization/rate-limit smoke.
- Atomic Host Redis tests: 13 passed, including concurrent extensions, leases, rescheduling, empty timelines, early reminder acknowledgment, and idle expiry.
- Dispatch: 18 native + 18 Upstash-compatible tests passed, including concurrent imports/tows, 500 vehicles, bounded round trips, and cancellation while waiting for an event.
- Docker and actual local Worker APIs: ordinary Host/Dispatcher/viewer permissions, concurrent extensions, saved shift duration unchanged, announcement edits, service authentication, ended-shift completion, release/retry, duplicate suppression, and completion retaining the room.
- Real HTTP disconnects remove presence in both Docker and local Workers. Workers opt into `enable_request_signal`; cleanup runs with `waitUntil`. See [Cloudflare's cancellation documentation](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/).
- Bot: 70 tests passed locally with `.env` loading disabled and inside its Docker image; Worker bundle dry run passed. Actual workerd accepts a correctly signed Discord PING and refuses a forged signature.
- Frontend: zero Svelte errors/warnings, tests, production builds, and local Worker runtime regressions. Real Chromium flows exercise import, image upload, extension, rescheduling, dispatcher acknowledgment, and schedule save in Docker and Workers. No browser errors or horizontal overflow at 320/375 pixels. Desktop, dim, light and midnight captures were inspected.

Discord message edits and modal uploads are covered by REST/interaction regression tests. No connected production guild was used for live delivery testing.

## CPU and storage calls

The final ordinary-Host workerd profile measured 10 requests per operation after five warm-up requests. GET snapshot: mean 6.03 ms, maximum 8.59 ms; extension: mean 5.34 ms, maximum 6.41 ms; note edit: mean 6.33 ms, maximum 8.21 ms. Results are in `host-worker-cpu-results.json`. These are local V8 sampling estimates with idle/root samples excluded, including permission checks; they are not production CPU billing or a guarantee for cold starts, large uploads, or every hardware/load condition. Earlier profiles had outliers above 10 ms. The final isolated run was below the target for all 30 samples; production measurements are still needed to confirm the same budget under real load.

A warm ordinary-Host snapshot uses one session/user SQL join, one permission-cache read, and one atomic room read/settle script. Extensions and note edits use one session SQL join plus three Redis commands (room, permission, mutation). Timeline mutations publish the resulting snapshot from the same Lua script. Vehicle imports/solves retain their existing bounded pipelines; extending a long shift also renews its vehicle TTLs inside the same Redis operation.

## Reproduction

Use an isolated stack only. The helpers deliberately use fixed scratch ports and `/tmp/trptools-host-fixture.json`; do not point them at a production database. `docs/host-verification-compose.yml` overrides the normal Compose ports, storage keys, and bot credentials for this scratch stack.

From `Project`, build `trptools-hostverify` with the normal Compose file and this override, enabling `full` and `bot` profiles. Start only backend/frontend and their storage dependencies. Seed this scratch database, save its output at `/tmp/trptools-host-seed.log`, then run backend `scripts/host-local-setup.ts` to create the fixture.

Run backend `scripts/host-worker-gateway.ts`, then `wrangler dev scripts/host-worker-entry.ts` on port 53002 with its local Neon/Upstash gateway at 56490. Supply the test database URL, local service token, Garage credentials and frontend origins from the Compose override. The wrapper and gateway are verification-only and are never production Worker entry points.

Build the frontend and run its `wrangler dev --env local` on 53003 with both API URLs pointing at 53002. Run backend HTTP/bot/disconnect scripts and `host-worker-cpu.ts` sequentially; they share one fixture. Run `host-showcase-setup.ts` immediately before each browser capture, then frontend `test:host:ui` once for Docker and once with `HOST_UI_RUNTIME=worker`. `CHROMIUM_PATH` can override the local browser executable.

The bot Docker tests use `compose run --rm --no-deps --entrypoint bun bot --no-env-file test src`, with both profiles enabled. This runs tests without connecting its gateway or registering commands. Its standalone local runtime smoke is `bun run worker:smoke`.
