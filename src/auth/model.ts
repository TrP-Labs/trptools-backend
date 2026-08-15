import { t } from 'elysia'

export namespace AuthModel {
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
        siteRank: t.String(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()]),
        theme: t.String(),
        locale: t.String(),
        timezone: t.String()
    })
    export type SessionUser = typeof SessionUser.static

    export const SessionResponse = t.Object({
        authenticated: t.Boolean(),
        user: t.Optional(SessionUser)
    })
    export type SessionResponse = typeof SessionResponse.static

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
