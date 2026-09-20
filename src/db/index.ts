import { drizzle } from 'drizzle-orm/postgres-js'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../utils/env'
import * as schema from './schema'

/**
 * Bun keeps its native Postgres connection pool. Workers use Neon's stateless
 * HTTP transport, because an isolate may not carry a socket from one request
 * context into the next. Both expose the same Drizzle query surface.
 */
export const client = env.isCloudflareWorker
    ? null
    : postgres(env.DATABASE_URL, {
          max: env.isProduction ? 20 : 5,
          idle_timeout: 30,
          connect_timeout: 15,
          prepare: false
      })

const localDatabase = client ? drizzle(client, { schema, casing: 'snake_case' }) : null
const workerDatabase = env.isCloudflareWorker
    ? drizzleNeon(env.DATABASE_URL, { schema, casing: 'snake_case' })
    : null

export const db = (workerDatabase ?? localDatabase!) as PostgresJsDatabase<typeof schema>

export { schema }
export default db
