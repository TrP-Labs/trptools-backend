import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import Redis from 'ioredis'
import postgres from 'postgres'
const fixture = JSON.parse(
        await readFile('/tmp/trptools-host-fixture.json', 'utf8'),
    ),
    token = fixture.showcaseToken ?? fixture.token
const redis = new Redis('redis://localhost:56379'),
    sql = postgres('postgresql://trptools:trptools@localhost:55432/trptools', {
        prepare: false,
    })
const [session] =
    await sql`select user_id from sessions where session_id=${createHash('sha256').update(token).digest('hex')}`
try {
    for (const origin of ['http://localhost:53001', 'http://localhost:53002']) {
        const key = 'dispatchroom:' + fixture.roomId + ':users',
            before = Number((await redis.hget(key, session!.user_id)) ?? 0)
        // Destroy the response socket rather than leaving a reusable HTTP connection.
        // This is the disconnect path the local workerd listener can observe reliably.
        const child = Bun.spawn(
            [
                'node',
                '--input-type=module',
                '-e',
                `
    import http from 'node:http';import {readFile} from 'node:fs/promises';
    const f=JSON.parse(await readFile('/tmp/trptools-host-fixture.json','utf8'));
    const req=http.get('${origin}/dispatch/'+f.roomId+'/connect',{agent:false,headers:{cookie:'access_token='+(f.showcaseToken??f.token)}},res=>{
      if(res.statusCode!==200)process.exit(1);
      res.once('data',()=>{res.socket.destroy();res.destroy();req.destroy();});
    });req.on('error',()=>{});
  `,
            ],
            { stdout: 'ignore', stderr: 'inherit' },
        )
        await child.exited
        const deadline = Date.now() + 20000
        while (
            Number((await redis.hget(key, session!.user_id)) ?? 0) !== before &&
            Date.now() < deadline
        )
            await Bun.sleep(20)
        assert.equal(
            Number((await redis.hget(key, session!.user_id)) ?? 0),
            before,
            origin + ' leaked presence after disconnect',
        )
        console.log(origin + ' canceled stream releases presence')
    }
} finally {
    redis.disconnect()
    await sql.end()
}
