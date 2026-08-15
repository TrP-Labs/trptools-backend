import { sha256 } from '@oslojs/crypto/sha2'
import { encodeBase32LowerCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding'
import { eq } from 'drizzle-orm'
import db from '../db'
import { apiKeys, sessions, users } from '../db/schema'
import { isBanned } from './moderation'
import { env } from './env'

export type SessionUser = {
    userId: string
    robloxId: number
    siteRank: string
}

export type session = {
    authenticated: boolean
    user?: SessionUser
    /** True when the caller authenticated with an API key rather than a cookie. */
    viaApiKey?: boolean
    scopes?: string[]
}

export const anonymous: session = { authenticated: false, user: undefined }

export function generateSessionToken(): string {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return encodeBase32LowerCaseNoPadding(bytes)
}

export function hashToken(token: string): string {
    return encodeHexLowerCase(sha256(new TextEncoder().encode(token)))
}

const SESSION_TTL_MS = env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
const SESSION_REFRESH_MS = SESSION_TTL_MS / 2

/** Resolves a raw session token into a session. Never throws. */
export default async function GetSession(token: string | undefined): Promise<session> {
    if (!token) return anonymous

    const sessionId = hashToken(token)

    const [row] = await db
        .select({
            sessionId: sessions.sessionId,
            expiresAt: sessions.expiresAt,
            userId: users.id,
            robloxId: users.robloxId,
            siteRank: users.siteRank,
            bannedAt: users.bannedAt,
            banExpiresAt: users.banExpiresAt
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.sessionId, sessionId))
        .limit(1)
        .catch(() => [])

    if (!row) return anonymous

    // A suspended account is treated as signed out everywhere. Banning also
    // deletes the account's sessions, so this only catches one created in the
    // moments around the ban — but it is the check that makes the suspension
    // hold for every route at once.
    if (isBanned(row)) return anonymous

    if (Date.now() >= row.expiresAt.getTime()) {
        await db.delete(sessions).where(eq(sessions.sessionId, sessionId)).catch(() => undefined)
        return anonymous
    }

    // Slide the expiry once the session passes its halfway point.
    if (Date.now() >= row.expiresAt.getTime() - SESSION_REFRESH_MS) {
        await db
            .update(sessions)
            .set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
            .where(eq(sessions.sessionId, sessionId))
            .catch(() => undefined)
    }

    return {
        authenticated: true,
        user: {
            userId: row.userId,
            robloxId: row.robloxId,
            siteRank: row.siteRank
        }
    }
}

/** Resolves an `Authorization: Bearer <key>` header into a session. */
export async function GetApiKeySession(header: string | undefined): Promise<session> {
    if (!header) return anonymous

    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match?.[1]) return anonymous

    const [row] = await db
        .select({
            keyId: apiKeys.keyId,
            scopes: apiKeys.scopes,
            revokedAt: apiKeys.revokedAt,
            userId: users.id,
            robloxId: users.robloxId,
            siteRank: users.siteRank,
            bannedAt: users.bannedAt,
            banExpiresAt: users.banExpiresAt
        })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .where(eq(apiKeys.token, hashToken(match[1])))
        .limit(1)
        .catch(() => [])

    // Keys are left intact through a suspension — they start working again on
    // its own when a temporary one lapses, rather than needing to be reissued.
    if (!row || row.revokedAt || isBanned(row)) return anonymous

    // Best effort — never block the request on bookkeeping.
    void db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.keyId, row.keyId))
        .catch(() => undefined)

    return {
        authenticated: true,
        viaApiKey: true,
        scopes: row.scopes.split(' ').filter(Boolean),
        user: {
            userId: row.userId,
            robloxId: row.robloxId,
            siteRank: row.siteRank
        }
    }
}

/** Cookie first, API key second. Used by every controller through `sessionPlugin`. */
export async function ResolveSession(
    cookieToken: string | undefined,
    authorization: string | undefined
): Promise<session> {
    const fromCookie = await GetSession(cookieToken)
    if (fromCookie.authenticated) return fromCookie
    return GetApiKeySession(authorization)
}

/** API key callers are limited to the scopes they were issued. */
export function hasScope(session: session, scope: string): boolean {
    if (!session.viaApiKey) return true
    return session.scopes?.includes(scope) ?? false
}
