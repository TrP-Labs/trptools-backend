import { status } from 'elysia'
import { decodeIdToken, generateCodeVerifier, generateState, type OAuth2Tokens } from 'arctic'
import { and, desc, eq, isNull } from 'drizzle-orm'
import db from '../db'
import { apiKeys, sessions, users } from '../db/schema'
import { env } from '../utils/env'
import { Roblox } from '../utils/roblox'
import { OAUTH_SCOPES, robloxOAuth, storeUserTokens } from '../utils/robloxCredentials'
import { generateSessionToken, hashToken, type session } from '../utils/sessionVerifier'
import { isBanned } from '../utils/moderation'
import { globalModel } from '../utils/globalModel'
import { API_SCOPES, AuthModel } from './model'

/**
 * A finished OAuth exchange either yields a session or refuses to.
 *
 * A refusal is not an error the browser should see as one — the callback is a
 * top-level navigation, so it has to end at a page that explains itself.
 */
export type OAuthOutcome = { token: string } | { banned: { until: Date | null } }

interface RobloxOAuthClaims {
    sub: string
    name?: string
    nickname?: string
    preferred_username?: string
    picture?: string
}

const SESSION_TTL_MS = env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000

export abstract class Session {
    static async GenerateLogin(): Promise<AuthModel.GeneratedLoginData> {
        if (!robloxOAuth) {
            throw status(503, 'Roblox OAuth is not configured' satisfies AuthModel.oauthUnavailable)
        }

        const state = generateState()
        const codeVerifier = generateCodeVerifier()
        const url = robloxOAuth.createAuthorizationURL(state, codeVerifier, OAUTH_SCOPES).toString()

        return { url, state, codeVerifier }
    }

    static async VerifyOAuth(
        code: string,
        state: string,
        storedCode: string | undefined,
        storedState: string | undefined
    ): Promise<OAuthOutcome> {
        if (!robloxOAuth) {
            throw status(503, 'Roblox OAuth is not configured' satisfies AuthModel.oauthUnavailable)
        }

        // The state cookie is all that stands between us and a login CSRF.
        if (!storedState || !storedCode || state !== storedState) {
            throw status(400, 'Bad Request' satisfies globalModel.badRequest)
        }

        let tokens: OAuth2Tokens
        try {
            tokens = await robloxOAuth.validateAuthorizationCode(code, storedCode)
        } catch {
            throw status(400, 'Bad Request' satisfies globalModel.badRequest)
        }

        const claims = decodeIdToken(tokens.idToken()) as unknown as RobloxOAuthClaims
        const robloxUserId = claims.sub

        if (!robloxUserId || !/^\d+$/.test(robloxUserId)) {
            throw status(400, 'Bad Request' satisfies globalModel.badRequest)
        }

        const robloxId = Number(robloxUserId)
        const isSiteAdmin = env.SITE_ADMINS.includes(robloxUserId)

        const identity = {
            cachedUsername: claims.preferred_username ?? claims.nickname ?? null,
            cachedDisplayName: claims.name ?? claims.nickname ?? null,
            cachedAvatar: claims.picture ?? null,
            cachedAt: new Date()
        }

        const [user] = await db
            .insert(users)
            .values({
                robloxId,
                siteRank: isSiteAdmin ? 'admin' : 'user',
                ...identity
            })
            .onConflictDoUpdate({
                target: users.robloxId,
                set: {
                    ...identity,
                    ...(isSiteAdmin ? { siteRank: 'admin' } : {})
                }
            })
            .returning({ id: users.id, bannedAt: users.bannedAt, banExpiresAt: users.banExpiresAt })

        if (!user) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        // Signing in again is the obvious way around a ban, so it is checked
        // before any session or token is issued. Nothing is stored for a
        // suspended account either.
        if (isBanned(user)) return { banned: { until: user.banExpiresAt } }

        // Hold on to the OAuth tokens — Open Cloud v2 needs a bearer token to
        // read group membership, and this is the only chance to capture them.
        await storeUserTokens(user.id, tokens)

        const sessionToken = generateSessionToken()

        await db.insert(sessions).values({
            sessionId: hashToken(sessionToken),
            expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            userId: user.id
        })

        return { token: sessionToken }
    }

    static async Destroy(token: string | undefined) {
        if (!token) return
        await db.delete(sessions).where(eq(sessions.sessionId, hashToken(token)))
    }

    static async DestroyAll(userId: string) {
        await db.delete(sessions).where(eq(sessions.userId, userId))
    }

    static async Describe(session: session): Promise<AuthModel.SessionResponse> {
        if (!session.user) return { authenticated: false }

        const [user] = await db.select().from(users).where(eq(users.id, session.user.userId)).limit(1)
        if (!user) return { authenticated: false }

        // Refresh the cached Roblox identity in the background once it ages out.
        const stale = !user.cachedAt || Date.now() - user.cachedAt.getTime() > 1000 * 60 * 60 * 12
        if (stale) void Session.RefreshIdentity(user.id, user.robloxId)

        return {
            authenticated: true,
            user: {
                userId: user.id,
                robloxId: user.robloxId,
                siteRank: user.siteRank,
                username: user.cachedUsername,
                displayName: user.cachedDisplayName,
                avatar: user.cachedAvatar,
                theme: user.theme,
                locale: user.locale,
                timezone: user.timezone
            }
        }
    }

    static async RefreshIdentity(userId: string, robloxId: number) {
        try {
            const [profile, avatar] = await Promise.all([Roblox.getUser(robloxId), Roblox.getAvatar(robloxId)])
            if (!profile && !avatar) return

            await db
                .update(users)
                .set({
                    cachedUsername: profile?.name ?? undefined,
                    cachedDisplayName: profile?.displayName ?? undefined,
                    cachedAvatar: avatar ?? undefined,
                    cachedAt: new Date()
                })
                .where(eq(users.id, userId))
        } catch {
            // Identity refresh is opportunistic.
        }
    }
}

export abstract class ApiKeys {
    static async list(userId: string): Promise<AuthModel.ApiKeyList> {
        const rows = await db
            .select()
            .from(apiKeys)
            .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
            .orderBy(desc(apiKeys.createdAt))

        return rows.map((key) => ({
            keyId: key.keyId,
            name: key.name,
            prefix: key.prefix,
            scopes: key.scopes.split(' ').filter(Boolean),
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt
        }))
    }

    static async create(userId: string, body: AuthModel.CreateApiKeyBody): Promise<AuthModel.CreateApiKeyResponse> {
        const existing = await db
            .select({ keyId: apiKeys.keyId })
            .from(apiKeys)
            .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))

        if (existing.length >= 10) throw status(409, 'Conflict' satisfies globalModel.conflict)

        const requested = body.scopes?.filter((scope) => (API_SCOPES as readonly string[]).includes(scope)) ?? []
        const scopes = requested.length > 0 ? requested : ['groups:read', 'routes:read', 'schedule:read']

        const token = `trp_${generateSessionToken()}`

        const [key] = await db
            .insert(apiKeys)
            .values({
                token: hashToken(token),
                name: body.name,
                prefix: token.slice(0, 12),
                scopes: scopes.join(' '),
                userId
            })
            .returning({ keyId: apiKeys.keyId })

        if (!key) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        // The only moment the plaintext token exists outside the client.
        return { keyId: key.keyId, token }
    }

    static async revoke(userId: string, keyId: string) {
        const revoked = await db
            .update(apiKeys)
            .set({ revokedAt: new Date() })
            .where(and(eq(apiKeys.keyId, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
            .returning({ keyId: apiKeys.keyId })

        if (revoked.length === 0) throw status(404, 'Not Found' satisfies globalModel.notFound)
    }
}
