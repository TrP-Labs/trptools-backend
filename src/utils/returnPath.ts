/**
 * Where a redirect the site performs on somebody's behalf may land them.
 *
 * The Discord link flow leaves the site and comes back, carrying a path the
 * caller asked to return to — which is exactly the shape an open redirect
 * takes if it is believed. This file imports nothing at all so
 * `returnPath.test.ts` can pin it without a database or an environment, the
 * same split as `membershipRule.ts` and `applications/eligibility.ts`.
 */

/** Where a caller lands when it asked for nothing, or for something unsafe. */
export const DEFAULT_RETURN_PATH = '/settings'

/**
 * A site-relative path, or the default.
 *
 * One leading slash and nothing a browser could read as a host. `//evil.com`
 * is protocol-relative and `https://evil.com` absolute — both would leave the
 * site — and a backslash is treated as a slash by browsers while not looking
 * like one here, which is how `/\evil.com` gets through a naive check.
 */
export function safeReturnPath(requested: string | undefined | null): string {
    if (!requested) return DEFAULT_RETURN_PATH
    if (!requested.startsWith('/')) return DEFAULT_RETURN_PATH
    if (requested.startsWith('//')) return DEFAULT_RETURN_PATH
    if (requested.includes('\\')) return DEFAULT_RETURN_PATH

    return requested
}
