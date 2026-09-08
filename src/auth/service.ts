import { status } from 'elysia'
import { decodeIdToken, generateCodeVerifier, generateState, type OAuth2Tokens } from 'arctic'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import db from '../db'
import { apiKeys, sessions, users } from '../db/schema'
import { env } from '../utils/env'
import { Roblox } from '../utils/roblox'
import { OAUTH_SCOPES, robloxOAuth, storeUserTokens } from '../utils/robloxCredentials'
import { generateSessionToken, hashToken, isAdminAccount, type session } from '../utils/sessionVerifier'
import { invalidateUserPermissions } from '../utils/groupPermission'
import { isBanned } from '../utils/moderation'
import { globalModel } from '../utils/globalModel'
import { dataRedis } from '../utils/redis'
import { DEFAULT_RETURN_PATH, safeReturnPath } from '../utils/returnPath'
import { FRONTEND_URL } from '../utils/env'
import { avatarUrl, Discord, discordConfigured, displayName } from '../bot/discord'
import { BotModel } from '../bot/model'
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

/**
 * A linked Discord account as every response shows it, or null.
 *
 * `discordId` is the one field that decides: the username and avatar are
 * conveniences that a link made before this shipped may not carry, and an
 * account whose id is set is linked whether or not we know what to call it.
 */
export function presentDiscord(user: {
    discordId: string | null
    discordUsername: string | null
    discordAvatar: string | null
    discordLinkedAt: Date | null
}): AuthModel.DiscordAccount | null {
    if (!user.discordId) return null

    return {
        id: user.discordId,
        username: user.discordUsername ?? user.discordId,
        avatar: user.discordAvatar,
        linkedAt: user.discordLinkedAt
    }
}

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
                // Read back off the session rather than the account: the
                // standing is the account's, using it is this session's.
                adminMode: session.user.adminMode,
                primaryGroupId: user.primaryGroupId,
                username: user.cachedUsername,
                displayName: user.cachedDisplayName,
                avatar: user.cachedAvatar,
                theme: user.theme,
                locale: user.locale,
                timezone: user.timezone,
                discord: presentDiscord(user)
            }
        }
    }

    /**
     * Turns this one session's site-admin powers on or off.
     *
     * Scoped to the session on purpose: an admin can hold an elevated window
     * and an ordinary one at the same time, and closing the browser is enough
     * to drop back to an ordinary account. Only a cookie session can be
     * elevated — an API key has nowhere to make the choice, so it never is.
     */
    static async SetAdminMode(token: string | undefined, session: session, enabled: boolean): Promise<boolean> {
        if (!isAdminAccount(session)) throw status(403, 'Forbidden' satisfies globalModel.forbidden)
        if (!token || session.viaApiKey) throw status(403, 'Forbidden' satisfies globalModel.forbidden)

        const updated = await db
            .update(sessions)
            .set({ adminMode: enabled })
            .where(eq(sessions.sessionId, hashToken(token)))
            .returning({ adminMode: sessions.adminMode })

        if (updated.length === 0) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        // Group permission is cached per user for a minute, and the cached
        // entry was computed with the bypass in force. Throwing it away makes
        // the switch take effect on the very next request rather than up to a
        // minute later, which matters most in the direction that *removes*
        // access.
        await invalidateUserPermissions(session.user!.userId)

        return enabled
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

/**
 * Connecting a Discord account to a TrPTools one.
 *
 * The site has always *recorded* a Discord id — a sign-up taken from a Discord
 * sheet carries one — but nothing ever put one on an account, so the column
 * was only ever read and the two halves of a sign-up sheet could not be shown
 * as the same person. This is the flow that fills it in.
 *
 * Nothing is gated on it site-wide. A group may require it (`groups`), and
 * that is the only thing it decides.
 */
const LINK_TTL = 600
const linkKey = (state: string) => `discord:link:${state}`

const discordRedirectUri = () => `${env.BASE_URL}/auth/discord/callback`


function assertDiscordConfigured() {
    if (!discordConfigured) {
        throw status(503, 'Discord is not configured on this instance' satisfies BotModel.unavailable)
    }
}

export abstract class DiscordLink {
    /**
     * Begins the link, parking who asked under a random state value.
     *
     * The user id goes into Redis rather than being read off the session at
     * the callback: the callback is a top-level navigation from Discord, and a
     * cookie is not guaranteed to travel with it under every SameSite policy
     * a deployment might end up with. It is the same reasoning the bot install
     * uses, and it keeps the callback outside the session plugin entirely.
     */
    static async Begin(
        session: session,
        query: AuthModel.DiscordLinkQuery = {}
    ): Promise<AuthModel.DiscordLinkResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)
        assertDiscordConfigured()

        const state = generateSessionToken()
        await dataRedis.set(
            linkKey(state),
            JSON.stringify({ userId: session.user.userId, returnTo: safeReturnPath(query.returnTo) }),
            'EX',
            LINK_TTL
        )

        const url = new URL('https://discord.com/oauth2/authorize')
        url.searchParams.set('client_id', env.DISCORD_APP_ID)
        // `identify` and nothing else: the site wants a name and an id, and a
        // scope it does not read is one it would still have to justify to
        // whoever is being asked to grant it.
        url.searchParams.set('scope', 'identify')
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('redirect_uri', discordRedirectUri())
        url.searchParams.set('state', state)
        // Discord otherwise skips the consent screen for an application the
        // account has already authorised, which makes "link a different
        // account" impossible to do without visiting Discord's own settings.
        url.searchParams.set('prompt', 'consent')

        return { url: url.toString() }
    }

    /**
     * Finishes the link and lands the browser back on the settings page.
     *
     * Every outcome is a redirect, including the failures: this is a top-level
     * navigation, so a JSON error would leave somebody looking at a bare
     * string where a page should be.
     */
    static async Complete(query: AuthModel.DiscordCallbackQuery): Promise<string> {
        // Until the parked state is read there is nowhere to go back to, so
        // everything before that lands on settings — which is where the link
        // can be tried again from in any case.
        let path = DEFAULT_RETURN_PATH
        const back = (result: string) =>
            `${FRONTEND_URL}${path}${path.includes('?') ? '&' : '?'}discord=${result}`

        if (!discordConfigured) return back('unavailable')
        if (query.error || !query.code || !query.state) return back('cancelled')

        const raw = await dataRedis.get(linkKey(query.state)).catch(() => null)
        if (!raw) return back('expired')
        await dataRedis.del(linkKey(query.state)).catch(() => undefined)

        const { userId, returnTo } = JSON.parse(raw) as { userId: string; returnTo: string }
        path = safeReturnPath(returnTo)

        const identity = await Discord.exchangeIdentity(query.code, discordRedirectUri())
        if (!identity) return back('failed')

        // One Discord account cannot stand for two TrPTools ones: a sign-up
        // sheet resolves a Discord id to an account, and a shared id would
        // make that ambiguous. The column is unique, so this is the readable
        // version of an error the database would raise anyway.
        const [claimed] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.discordId, identity.id))
            .limit(1)

        if (claimed && claimed.id !== userId) return back('taken')

        await db
            .update(users)
            .set({
                discordId: identity.id,
                discordUsername: displayName(identity),
                discordAvatar: avatarUrl(identity),
                discordLinkedAt: new Date()
            })
            .where(eq(users.id, userId))

        return back('linked')
    }

    /**
     * Disconnects the account.
     *
     * Sign-ups already taken keep whatever identity they were taken under —
     * a web sign-up carries the user id and a Discord one its own — so this
     * withdraws the link and nothing else. It may cost the person access to a
     * group that requires one, which is the group's rule rather than a reason
     * to refuse.
     */
    static async Unlink(session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [cleared] = await db
            .update(users)
            .set({ discordId: null, discordUsername: null, discordAvatar: null, discordLinkedAt: null })
            .where(and(eq(users.id, session.user.userId), isNotNull(users.discordId)))
            .returning({ id: users.id })

        if (!cleared) {
            throw status(404, 'no Discord account is linked' satisfies AuthModel.noDiscordLinked)
        }

        return 'Success' as globalModel.genericSuccess
    }
}
