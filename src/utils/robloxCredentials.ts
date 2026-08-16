import { eq } from 'drizzle-orm'
import { Roblox as RobloxOAuth, type OAuth2Tokens } from 'arctic'
import db from '../db'
import { groups, users } from '../db/schema'
import { decryptSecret, encryptSecret } from './crypto'
import { env, robloxConfigured } from './env'
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
export async function userCredentials(userId: string): Promise<RobloxCredentials> {
    const [user] = await db
        .select({
            accessToken: users.robloxAccessToken,
            refreshToken: users.robloxRefreshToken,
            expiresAt: users.robloxTokenExpiresAt
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

    let tokens: OAuth2Tokens
    try {
        tokens = await robloxOAuth.refreshAccessToken(refreshToken)
    } catch {
        // The refresh token is spent or revoked. Drop it so we stop retrying
        // and fall back to the other credential tiers.
        await db
            .update(users)
            .set({ robloxAccessToken: null, robloxRefreshToken: null, robloxTokenExpiresAt: null })
            .where(eq(users.id, userId))
            .catch(() => undefined)
        return {}
    }

    const accessToken = tokens.accessToken()
    await storeUserTokens(userId, tokens)

    return { accessToken }
}

/** Persists a fresh OAuth token set, encrypted. */
export async function storeUserTokens(userId: string, tokens: OAuth2Tokens) {
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

    await db
        .update(users)
        .set({
            robloxAccessToken: await encryptSecret(tokens.accessToken()),
            robloxRefreshToken: refreshToken ? await encryptSecret(refreshToken) : null,
            robloxTokenExpiresAt: expiresAt,
            robloxScopes: OAUTH_SCOPES.join(' ')
        })
        .where(eq(users.id, userId))
        .catch(() => undefined)
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
