import { eq } from 'drizzle-orm'
import { Roblox as RobloxOAuth, type OAuth2Tokens } from 'arctic'
import db from '../db'
import { groups, users } from '../db/schema'
import { decryptSecret, encryptSecret } from './crypto'
import { env, robloxConfigured } from './env'
import { dataRedis } from './redis'
import { robloxWriteScopes } from './robloxOAuthScopes'
import type { RobloxCredentials } from './roblox'

export const robloxOAuth = robloxConfigured
    ? new RobloxOAuth(env.ROBLOX_CLIENT_ID, env.ROBLOX_CLIENT_SECRET, `${env.BASE_URL}/auth/callback`)
    : null

/**
 * Scopes requested at login.
 *
 * `group:read` is what lets us read a user's group membership from Open Cloud
 * v2. It has to be enabled on the app in the Creator Dashboard as well as
 * requested here, otherwise Roblox rejects the authorization outright.
 */
export const OAUTH_SCOPES = ['openid', 'profile', 'group:read']

/**
 * The Open Cloud API key supplied for a group, decrypted.
 *
 * Stored against the group, but owned by a user account — Open Cloud refuses
 * group-owned keys on every `/cloud/v2/groups` route.
 */
export async function groupCredentials(groupId: string): Promise<RobloxCredentials> {
    const [group] = await db
        .select({ openCloudKey: groups.openCloudKey })
        .from(groups)
        .where(eq(groups.id, groupId))
        .limit(1)
        .catch(() => [])

    if (!group?.openCloudKey) return {}
    return { apiKey: await decryptSecret(group.openCloudKey) }
}

/**
 * The user's own OAuth access token, refreshing it first if it has expired.
 *
 * Roblox refresh tokens last 90 days and are single use — each refresh returns
 * a new pair, so the replacement is written straight back.
 */
export async function userCredentials(userId: string, write = false): Promise<RobloxCredentials> {
    const [user] = await db
        .select({
            accessToken: write ? users.robloxWriteAccessToken : users.robloxAccessToken,
            refreshToken: write ? users.robloxWriteRefreshToken : users.robloxRefreshToken,
            expiresAt: write ? users.robloxWriteTokenExpiresAt : users.robloxTokenExpiresAt,
            robloxId: users.robloxId,
            scopes: write ? users.robloxWriteScopes : users.robloxScopes
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .catch(() => [])

    if (!user?.accessToken) return {}

    const stillValid = user.expiresAt && user.expiresAt.getTime() - 60_000 > Date.now()
    if (stillValid) return { accessToken: await decryptSecret(user.accessToken) }

    if (!robloxOAuth || !user.refreshToken) return {}

    const refreshToken = await decryptSecret(user.refreshToken)
    if (!refreshToken) return {}

    const lockKey = `roblox:refresh:${write ? 'write' : 'read'}:${userId}`
    const owner = crypto.randomUUID()
    const acquired = await dataRedis.set(lockKey, owner, 'EX', 30, 'NX').catch(() => null)
    if (!acquired) {
        // A single-use refresh token must never be spent by two requests.
        for (let attempt = 0; attempt < 40; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 250))
            const held = await dataRedis.exists(lockKey).catch(() => null)
            if (held === null) return {}
            if (!held) return userCredentials(userId, write)
        }
        return {}
    }
    try {
        // A preceding refresh may have finished just before this lock was won.
        const [current] = await db.select({
            access: write ? users.robloxWriteAccessToken : users.robloxAccessToken,
            refresh: write ? users.robloxWriteRefreshToken : users.robloxRefreshToken,
            expires: write ? users.robloxWriteTokenExpiresAt : users.robloxTokenExpiresAt
        }).from(users).where(eq(users.id, userId)).limit(1)
        if (current?.expires && current.expires.getTime() - 60_000 > Date.now() && current.access) {
            return { accessToken: await decryptSecret(current.access) }
        }
        const secret = current?.refresh ? await decryptSecret(current.refresh) : null
        if (!secret) return {}
        let tokens: OAuth2Tokens
        try { tokens = await robloxOAuth.refreshAccessToken(secret) }
        catch {
            await db.update(users).set(write
                ? { robloxWriteAccessToken: null, robloxWriteRefreshToken: null, robloxWriteTokenExpiresAt: null, robloxWriteScopes: '' }
                : { robloxAccessToken: null, robloxRefreshToken: null, robloxTokenExpiresAt: null, robloxScopes: '' }
            ).where(eq(users.id, userId))
            return {}
        }
        let verifiedScopes: string[] | undefined
        if (write) {
            const grants = await robloxWriteScopes(tokens, env.ROBLOX_CLIENT_ID, env.ROBLOX_CLIENT_SECRET, user.robloxId)
            verifiedScopes = grants.state === 'UNAVAILABLE' ? [] : grants.scopes
        }
        // Persist the rotated refresh token even when permission verification
        // failed; an unconfirmed token must not be used for rank changes.
        await storeUserTokens(userId, tokens, user.scopes.split(' '), write, verifiedScopes)
        return { accessToken: tokens.accessToken() }
    } finally {
        await dataRedis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", [lockKey], [owner]).catch(() => undefined)
    }
}

/** Persists a fresh OAuth token set, encrypted. */
export async function storeUserTokens(userId: string, tokens: OAuth2Tokens, fallbackScopes: string[] = OAUTH_SCOPES, write = false, verifiedScopes?: string[]) {
    let refreshToken: string | null = null
    try {
        refreshToken = tokens.refreshToken()
    } catch {
        // Roblox omits a refresh token when the app was not granted offline access.
    }

    let expiresAt: Date | null = null
    try {
        expiresAt = tokens.accessTokenExpiresAt()
    } catch {
        expiresAt = new Date(Date.now() + 15 * 60 * 1000)
    }

    const access = await encryptSecret(tokens.accessToken())
    const refresh = refreshToken ? await encryptSecret(refreshToken) : null
    const scopes = (verifiedScopes ?? (tokens.hasScopes() ? tokens.scopes() : fallbackScopes)).join(' ')
    await db.update(users).set(write
        ? { robloxWriteAccessToken: access, robloxWriteRefreshToken: refresh, robloxWriteTokenExpiresAt: expiresAt, robloxWriteScopes: scopes }
        : { robloxAccessToken: access, robloxRefreshToken: refresh, robloxTokenExpiresAt: expiresAt, robloxScopes: scopes }
    ).where(eq(users.id, userId))
}

/**
 * The full credential set for reading `groupId` on behalf of `userId`.
 * The group's key is preferred; the user's token backs it up.
 */
export async function resolveCredentials(groupId: string, userId?: string): Promise<RobloxCredentials> {
    const [fromGroup, fromUser] = await Promise.all([
        groupCredentials(groupId),
        userId ? userCredentials(userId) : Promise.resolve({} as RobloxCredentials)
    ])

    return { apiKey: fromGroup.apiKey, accessToken: fromUser.accessToken }
}
