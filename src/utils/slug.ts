import { eq } from 'drizzle-orm'
import db from '../db'
import { groups } from '../db/schema'

const RESERVED = new Set([
    'new',
    'create',
    'admin',
    'api',
    'auth',
    'dashboard',
    'settings',
    'tools',
    'about',
    'login',
    'logout',
    'groups',
    'shifts',
    'routes',
    'me'
])

export function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
}

export function isValidSlug(value: string): boolean {
    return /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(value) && !RESERVED.has(value)
}

/**
 * Slug for something that lives under a group, such as a route or a depot.
 *
 * Route names are frequently bare numbers, which make for an opaque URL and
 * collide with nothing else meaningful, so a numeric name is prefixed with its
 * kind: route "9" becomes `route-9`, while depot "Main Island" stays
 * `main-island`.
 */
export function childSlug(kind: string, name: string, fallback: string | number): string {
    const base = slugify(name)
    if (!base) return slugify(`${kind}-${fallback}`)
    return /^\d+$/.test(base) ? `${kind}-${base}` : base
}

/**
 * Makes a slug unique within one group by appending a counter.
 *
 * `taken` is the set of slugs already in use, excluding the row being renamed.
 */
export function uniqueWithin(preferred: string, taken: Set<string>): string {
    if (!taken.has(preferred)) return preferred

    for (let counter = 2; counter < 200; counter += 1) {
        const candidate = `${preferred}-${counter}`
        if (!taken.has(candidate)) return candidate
    }

    return `${preferred}-${Date.now().toString(36)}`
}

/** Produces a slug that is guaranteed free, appending a counter if needed. */
export async function uniqueSlug(preferred: string, fallback: string): Promise<string> {
    let base = slugify(preferred)
    if (!base || base.length < 3 || RESERVED.has(base)) base = slugify(fallback) || 'group'
    if (base.length < 3) base = `group-${base}`

    let candidate = base
    let counter = 1

    // Bounded so a pathological dataset can never spin forever.
    while (counter < 200) {
        const [taken] = await db.select({ id: groups.id }).from(groups).where(eq(groups.slug, candidate)).limit(1)
        if (!taken && !RESERVED.has(candidate)) return candidate
        counter += 1
        candidate = `${base}-${counter}`
    }

    return `${base}-${Date.now().toString(36)}`
}
