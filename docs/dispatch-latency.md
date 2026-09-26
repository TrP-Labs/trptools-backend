# Dispatch Redis latency

Dispatch batches bulk operations into pipelines of at most 256 commands. Both
native ioredis and the Upstash REST client preserve scalar, script, and hash
replies. A failed command is surfaced; successful bulk writes are broadcast
before reporting a partial failure. Vehicle data is read without SQL decoration
when only state is needed, and an import decorates all new vehicles together.

With a warm permission cache and 150 ms Redis RTT:

| Operation, 50 vehicles | Old service round trips | New service round trips | New Redis time |
| --- | ---: | ---: | ---: |
| Import into an empty room | 203 | 4 | 600 ms |
| Reimport unchanged vehicles | 53 | 4 | 600 ms |
| Solve all vehicles | 102 | 4 | 600 ms |
| Ordinary edit or tow claim | 3 / 6 | 1 | 150 ms |
| Delete a vehicle and release its tows | 5 + 2 per released tow | 1 | 150 ms |
| Join or leave presence | 4 / 3–4 | 1 | 150 ms |

Authorization adds two Redis round trips for an ordinary dispatcher (previously
three), or one in elevated admin mode. Standalone Bun adds one round trip for
its global rate limiter; Workers use their native rate limiter. Database,
Roblox cache misses, browser network latency, subscription setup, and payload
transfer time are additional. These are service estimates, not production
benchmarks.

Seeds claim their hash/list entry atomically, and conditional bulk patches do
not resurrect deleted vehicles. Tow validation, deletion and tow release,
manual edits and their broadcasts, and presence changes use Lua scripts to
avoid races between dispatchers. Closing deletes the room and publishes CLOSED
atomically, checks the group index before removing it, then removes the room's
remaining state. Streams reuse the authorized room, fetch their snapshot while
joining, and reuse the returned presence. Natural expiry is checked once every
15 seconds per stream, independent of the event rate.

## Verification

`bun run test` runs the pure tests without external services. With `redis-server`
on PATH, `bun run test:dispatch` starts disposable Redis processes and runs the
service integration suite with native ioredis and the actual Upstash SDK against
a local REST/SSE gateway. It covers mixed pipeline replies, command failures,
partial publication, 50/500 vehicle batches, import state preservation,
simultaneous imports/tow claims/reconnects, deletion during a solve, grant and
admin mode checks, snapshot cleanup, explicit closure, natural expiry, and
simulated 150 ms RTT. The gateway honors Upstash's base64 response encoding.
SQL context reads are stubbed; Redis scripts and pub/sub use the real server.
