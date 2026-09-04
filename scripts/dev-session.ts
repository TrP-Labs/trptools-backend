/**
 * Mints a session for an existing account and prints the token.
 *
 * `db:seed` also prints one, but it rebuilds the demo data to do it — which is
 * the wrong tool when the database already has something worth keeping and all
 * that is wanted is a way to be signed in. This adds a session and touches
 * nothing else.
 *
 * Used by the frontend's screenshot script, and by hand whenever a browser
 * needs a signed-in session against a local stack.
 *
 *   bun run scripts/dev-session.ts             # first account
 *   bun run scripts/dev-session.ts <robloxId>  # a particular one
 *
 * Development only. It writes a session without anybody signing in, so it must
 * never run anywhere real — hence the refusal below.
 */
import { asc, desc, eq, sql } from 'drizzle-orm'
import db from '../src/db'
import { sessions, users } from '../src/db/schema'
import { env } from '../src/utils/env'
import { generateSessionToken, hashToken } from '../src/utils/sessionVerifier'

if (env.isProduction) {
    console.error('Refusing to run: NODE_ENV is production.')
    process.exit(1)
}

const wanted = process.argv[2]

/**
 * A site admin first, then the oldest account.
 *
 * Both halves matter. Without the ordering, `limit(1)` is whichever row
 * Postgres feels like returning — it is free to differ between two runs against
 * the same table, and it did: one run signed in as an admin and photographed
 * the whole site, the next signed in as an ordinary member and got 403 on every
 * group page. Preferring an admin is then what makes the session useful, since
 * the pages worth looking at are mostly ones an ordinary account cannot open.
 */
const [user] = wanted
    ? await db.select().from(users).where(eq(users.robloxId, Number(wanted))).limit(1)
    : await db
          .select()
          .from(users)
          .orderBy(desc(sql`${users.siteRank} = 'admin'`), asc(users.createdAt))
          .limit(1)

if (!user) {
    console.error(
        wanted
            ? `No account with Roblox id ${wanted}.`
            : 'No accounts in the database. Run `bun run db:seed` first.'
    )
    process.exit(1)
}

const token = generateSessionToken()

await db.insert(sessions).values({
    sessionId: hashToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    // On, because the pages worth looking at while signed in as a developer are
    // mostly the ones an admin can see.
    adminMode: true
})

console.log(
    `\nSession for ${user.cachedUsername ?? user.robloxId} (${user.siteRank}), good for 24 hours.\n`
)
console.log(`  TRPTOOLS_SESSION=${token}\n`)
console.log('In a browser on the dev site:\n')
console.log(`  document.cookie = "access_token=${token}; path=/"\n`)

process.exit(0)
