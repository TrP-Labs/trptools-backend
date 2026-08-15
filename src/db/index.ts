import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../utils/env'
import * as schema from './schema'

/**
 * postgres.js over Drizzle: a single small driver that works the same in Bun,
 * Node and on the edge, which is what we need to stay deployable everywhere.
 */
const client = postgres(env.DATABASE_URL, {
    max: env.isProduction ? 20 : 5,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false
})

export const db = drizzle(client, { schema, casing: 'snake_case' })

export { schema, client }
export default db
