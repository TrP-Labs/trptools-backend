/** Raw Drizzle results differ between postgres.js and Neon's HTTP transport. */
export function databaseRows<T extends Record<string, unknown> = Record<string, unknown>>(result: unknown): T[] {
    return Array.isArray(result) ? result as T[] : (result as { rows: T[] }).rows
}
