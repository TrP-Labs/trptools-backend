import { defineConfig } from 'drizzle-kit'

export default defineConfig({
    schema: './src/db/schema/index.ts',
    out: './drizzle',
    dialect: 'postgresql',
    casing: 'snake_case',
    dbCredentials: {
        url: process.env.DATABASE_URL ?? 'postgresql://trptools:trptools@localhost:5432/trptools'
    },
    strict: true,
    verbose: true
})
