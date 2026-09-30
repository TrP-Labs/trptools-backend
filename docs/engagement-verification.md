# Engagement features verification

Validated locally on 2026-09-29 (America/Phoenix). Work is on `dev`, with separate feature commits in the backend, frontend and Locales repositories. No push, deployment or release was performed.

## Shipped behavior

- Explicit group follows drive the personal shift list and user homepage. Following never grants permissions or exposes private shifts. The feed does not discover Roblox membership or query Redis. Existing host permissions remain in force.
- Optional browser reminders apply to a public shift series or every public shift in a group, around ten minutes before departure. Signup sheets offer a gentle reminder prompt. Devices and watches remain separate; account settings revoke this browser. Watches enabled near departure and devices added later trigger an idempotent replan.
- User and host homepages have independent persisted layouts and a switch beside the greeting. The catalogue contains 18 distinct widgets: 12 user choices and 13 host choices, with common widgets available in both. Add, remove, resize, keyboard reorder and drag reorder share one page payload rather than making requests per widget.
- Cosmetic Roblox/Discord join pages validate their destinations and explain external terms. Account instant redirects default off. Disabled links, hidden groups and private groups are refused. Settings require MANAGE_GROUP.
- Statistics appears below Overview and has an overview shortcut. It shows 7/30/90-day traffic, section totals, join-link visits/clicks/CTR, followers, reminder subscribers and aggregate route preferences. Custom votes are group-scoped; built-in votes follow the existing global route-preference contract and are labelled accordingly. Breakdowns require five votes. CTR measures opening the destination, not successfully joining it.

## Validation results

- Backend: 170 pure unit tests and 9 dashboard summary/schema tests passed; TypeScript, Bun build, Worker dry build, actual workerd health and native rate-limit smoke tests passed.
- API integration: 12 tests with 127 assertions passed against PostgreSQL 17 and Valkey. Coverage includes authentication/CSRF, private and cross-group targets, admin-mode changes, per-user preferences, layout validation, canonical join destinations, encrypted subscriptions and invalid curve keys, concurrent device limits, reassignment, overlapping watches, late opt-ins, bounded draining, delivery leases, privacy/recurrence revalidation, provider backoff and expired devices, anonymous counter origins/limits, atomic concurrent aggregation and scoped aggregate votes.
- The complete migration history through 0031 succeeded in a fresh disposable database. Existing isolated test storage upgraded successfully as well. Production storage was not reset.
- Frontend: 25 unit tests passed; Svelte checks reported zero errors/warnings. Both adapters built. Actual workerd tests passed SSR/session isolation, policy fallback and one API call per dashboard/shifts bootstrap. The shipped Docker image passed locales, assets, icons, client hydration, account appearance and mobile runtime checks.
- All three Docker images built. The unchanged bot passed its type check and 71 tests.
- Chromium passed 28 desktop/mobile feature captures with no browser errors or horizontal document overflow at 1440, 375 and 320 pixels. Interactions cover follow/unfollow, widget add/reorder/save/reload, mode switching, every widget, join confirmation, account instant redirect, signup reminder prompts, join settings and statistics. External join destinations were intercepted rather than visited.
- A dedicated production-frontend browser test passed explicit notification permission, real service-worker registration, API subscription, signup/header synchronization, mobile rendering and device revocation. Only browser push provisioning was replaced; notification requests went to the configured local Worker through a test-only route proxy. The provider was not contacted.
- Real workerd VAPID signing and AES128GCM encryption passed against an intercepted provider. A 30-delivery regression exercised concurrent drain requests, unique leases and waitUntil continuation past the 25-job batch without duplicate sends.

## CPU, storage and limits

The notification cron dispatches at most 20 due series per minute. Each plan and each send has its own Worker invocation. Drains use 25 jobs and at most 15 continuation batches per cron run, leaving room below the 50-subrequest limit and bounding Worker recursion. Responses are consumed/cancelled to release outgoing connection slots. Each delivery rechecks visibility, watch ownership, suspension and recurrence. Remaining work waits for the next tick. No notification job queries Roblox or Redis. Docker uses the same planner/outbox on an unreferenced minute timer.

Counter submission acknowledges before its one background SQL write. Aggregation claims at most 5,000 pending rows in one atomic SQL statement. Raw processed counters are pruned after seven days; daily aggregates persist. Counters store no account identity, IP, referrer or browsing history. DNT/GPC browsers are skipped. Worker rate limiting uses the native binding; Docker uses the existing Redis limiter. Counter numbers represent page events, not unique visitors, and can be approximate if browsers block or lose requests.

Homepage identity and widget data use one backend bootstrap request. User mode uses six batched SQL reads with followed groups present (session, follows, two existing preference lists, events, own signups), zero Redis reads and zero Roblox discovery requests. Query compilation is reused without caching user rows or authorization. Host mode retains the existing permission cache and batched room/sheet/review reads. Parsing caches at most 128 recurrence rules, keyed by both rule text and start time; result windows are not cached.

`engagement-worker-cpu-results.json` retains the earlier V8 sampling estimates for function profiling. Those estimates included homepage outliers (14.14 ms user, 10.28 ms host). Summing profiler sample intervals can include process descheduling and is unsuitable as proof of billed CPU usage. The independently measured page CPU results below supersede those page estimates. Reminder samples remain function-profile estimates, not Cloudflare billing measurements.

### Independent homepage/statistics CPU recheck

`engagement-page-cpu-results.json` records scheduled user + system CPU from each isolated local workerd process across its complete HTTP response. This excludes network/database waits and OS descheduling, while including native workerd process overhead. Frontend and API invocations are measured separately, as the 10 ms budget applies per Worker invocation. macOS libproc counters use Mach ticks; `mach_timebase_info` converts them to milliseconds. The conversion was checked against POSIX CPU accounting in the measuring process (67.54 vs 67.51 ms; see recorded calibration). [Apple's task accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c) defines the source counter in Mach time.

Both runs enabled all 12 user and 13 host widgets, with six owned users and two followed public groups in isolated test storage. Each of six routes had 15 warmups and 50 measured requests. The second run restarted both Workers before testing, retaining each route's first render and maximum warmup CPU as well. All 600 measured requests and the second run's 90 warmups stayed below 10 ms. The fresh-run one-second idle baseline was 0.19 ms for the API and zero for the frontend; no baseline was subtracted from request measurements.

| Route | API maximum, fresh run | SSR maximum, fresh run | First SSR render |
| --- | ---: | ---: | ---: |
| User home | 1.35 ms | 1.94 ms | 2.99 ms |
| Host home | 1.93 ms | 1.92 ms | 1.28 ms |
| Statistics | 1.80 ms | 2.06 ms | 1.67 ms |

The slowest measured request across both runs was **5.28 ms**, in host homepage SSR. Local page verification passes; production Cloudflare CPU telemetry and maximum-size workloads remain unverified. This is not a production free-tier guarantee. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) distinguish CPU time from network waiting.

## Reproduction and configuration

Use disposable `trptools_engagement_test` storage on local ports 5432/6379. Never point fixture scripts at production. `test:engagement` refuses a different database name and removes only its own rows. Browser fixtures write a private token to `/tmp/trptools-engagement-fixture.json`; do not commit it.

1. Apply migrations with `bun run db:migrate`, then run `bun run check` and `bun run test:engagement` with the test database URL and a test ENCRYPTION_KEY.
2. Run `scripts/engagement-fixture.ts`, then `scripts/engagement-worker-gateway.ts` and `scripts/engagement-worker-start.ts`. The latter uses the test-only Worker entry, ephemeral VAPID keys and a fake external provider. Never deploy `engagement-worker-entry.ts`.
3. Run `engagement-worker-notifications.ts`, `engagement-worker-cpu.ts` and `engagement-worker-batch.ts` sequentially; they share one owned device fixture. The CPU sampler needs the DATABASE_URL test guard and inspector on 54102.
4. Build Docker images and run the isolated API/frontend on 54101/54100 with the test database and matching FRONTEND_URL/ORIGIN. Run frontend `scripts/test-engagement-ui.ts` with ENGAGEMENT_UI_ORIGIN, ENGAGEMENT_API_ORIGIN and ENGAGEMENT_PUSH_CONFIGURED=false for an unconfigured Docker API. Run `test-engagement-push-ui.ts` with the configured Worker to exercise the optional push browser flow.
5. Run frontend `test:runtime <image>` and `test:worker`. Save screenshots from `/tmp/trptools-engagement-visual`, and remove only the owned fixtures with `engagement-fixture.ts --clean`.

For the independent page CPU recheck on macOS, keep the isolated API on 54002
and run the compiled frontend with `wrangler dev --env local --port 54000
--inspector-port 54103 --var PUBLIC_API_URL:http://localhost:54002 --var
INTERNAL_API_URL:http://localhost:54002` (disable dotenv loading). Run
`bun run scripts/engagement-page-cpu.ts`. It sets only the owned fixture's home
layout, makes sequential requests and writes `/tmp/trptools-page-cpu-results.json`.
The fixture and running Workers are required; the test does not deploy anything.

Production browser push requires HTTPS, stable VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, a contact VAPID_SUBJECT and ENCRYPTION_KEY. Workers additionally needs BACKGROUND_JOB_TOKEN and BASE_URL pointing back to the API Worker; the minute cron is declared in wrangler.jsonc. Set the new ANALYTICS_RATE_LIMIT binding. Compose/setup examples include these settings. Existing browsers must resubscribe after VAPID/encryption-key rotation. Unsupported browsers and unconfigured instances get an explanatory control. Push arrival is best-effort and may be delayed by the browser/provider; iOS requires a Home Screen installation.
