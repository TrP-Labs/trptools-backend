import { t } from 'elysia'

export namespace AuthModel {
    /** A linked Discord account, as every surface that shows one reads it. */
    export const DiscordAccount = t.Object({
        id: t.String(),
        /** Their display name, falling back to the handle. */
        username: t.String(),
        avatar: t.Union([t.String(), t.Null()]),
        linkedAt: t.Union([t.Date(), t.Null()])
    })
    export type DiscordAccount = typeof DiscordAccount.static

    export const GeneratedLoginData = t.Object({
        url: t.String(),
        state: t.String(),
        codeVerifier: t.String()
    })
    export type GeneratedLoginData = typeof GeneratedLoginData.static

    export const OauthCallbackQuery = t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String())
    })
    export type OauthCallbackQuery = typeof OauthCallbackQuery.static

    export const SessionUser = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        /**
         * When this account first signed in with Roblox.
         *
         * There is no separate "connected on" for the Roblox account, because
         * signing in with it is what creates the account — so the row's own
         * age is the date, and the settings card says so the same way the
         * Discord card does.
         */
        createdAt: t.Date(),
        /** What the account is. `adminMode` says what it is currently doing. */
        siteRank: t.String(),
        /**
         * Whether this session is exercising site-admin powers.
         *
         * Reported separately from `siteRank` so a client can tell the two
         * apart: the settings switch has to be offered to an admin whose mode
         * is off, and every admin-only link has to be hidden from that same
         * person until they turn it on.
         */
        adminMode: t.Boolean(),
        /** The group this person pinned as theirs, for the dashboard's shortcut. */
        primaryGroupId: t.Union([t.String(), t.Null()]),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()]),
        theme: t.String(),
        /** Both null mean "follow the browser" — see the columns' own comments. */
        locale: t.Union([t.String(), t.Null()]),
        timezone: t.Union([t.String(), t.Null()]),

        /**
         * The Discord account this person has connected, or null.
         *
         * Carried on the session rather than fetched where it is needed
         * because a group can require it before a sign-up or an application
         * is accepted, and the pages offering those have to be able to say so
         * — and offer the button — without a second round trip per shift.
         */
        discord: t.Union([DiscordAccount, t.Null()])
    })
    export type SessionUser = typeof SessionUser.static

    export const SessionResponse = t.Object({
        authenticated: t.Boolean(),
        user: t.Optional(SessionUser)
    })
    export type SessionResponse = typeof SessionResponse.static

    export const AdminModeBody = t.Object({ enabled: t.Boolean() })
    export type AdminModeBody = typeof AdminModeBody.static

    export const AdminModeResponse = t.Object({ adminMode: t.Boolean() })
    export type AdminModeResponse = typeof AdminModeResponse.static

    export const LoginUrlResponse = t.Object({
        url: t.String()
    })
    export type LoginUrlResponse = typeof LoginUrlResponse.static

    export const ApiKeyItem = t.Object({
        keyId: t.String(),
        name: t.String(),
        prefix: t.String(),
        scopes: t.Array(t.String()),
        createdAt: t.Date(),
        lastUsedAt: t.Union([t.Date(), t.Null()])
    })
    export type ApiKeyItem = typeof ApiKeyItem.static

    export const ApiKeyList = t.Array(ApiKeyItem)
    export type ApiKeyList = typeof ApiKeyList.static

    export const CreateApiKeyBody = t.Object({
        name: t.String({ minLength: 1, maxLength: 60 }),
        scopes: t.Optional(t.Array(t.String({ maxLength: 40 }), { maxItems: 12 }))
    })
    export type CreateApiKeyBody = typeof CreateApiKeyBody.static

    export const CreateApiKeyResponse = t.Object({
        keyId: t.String(),
        token: t.String()
    })
    export type CreateApiKeyResponse = typeof CreateApiKeyResponse.static

    export const oauthUnavailable = t.Literal('Roblox OAuth is not configured')
    export type oauthUnavailable = typeof oauthUnavailable.static

    export const DiscordLinkQuery = t.Object({
        json: t.Optional(t.String()),
        /**
         * Where to land afterwards, as a path on the site.
         *
         * The button that starts this appears on the shift page and the apply
         * form as well as in settings, and sending everybody to settings
         * regardless means somebody who pressed it to unblock a form has to
         * find their way back to the form. Validated as a site-relative path
         * on the way in — an absolute URL here would make the callback an open
         * redirect.
         */
        returnTo: t.Optional(t.String({ maxLength: 300 }))
    })
    export type DiscordLinkQuery = typeof DiscordLinkQuery.static

    /** Where to send the browser to authorise the Discord link. */
    export const DiscordLinkResponse = t.Object({ url: t.String() })
    export type DiscordLinkResponse = typeof DiscordLinkResponse.static

    export const DiscordCallbackQuery = t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String())
    })
    export type DiscordCallbackQuery = typeof DiscordCallbackQuery.static

    export const noDiscordLinked = t.Literal('no Discord account is linked')
    export type noDiscordLinked = typeof noDiscordLinked.static
}

export const API_SCOPES = [
    'groups:read',
    'groups:write',
    'routes:read',
    'routes:write',
    'schedule:read',
    'schedule:write',
    'dispatch:read',
    'dispatch:write'
] as const
