import { t } from 'elysia'

export namespace UserModel {
    export const publicProfile = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()]),
        siteRank: t.String()
    })
    export type publicProfile = typeof publicProfile.static

    export const profileList = t.Array(publicProfile)
    export type profileList = typeof profileList.static

    /**
     * Dispatch renders owner names for vehicles, which are Roblox ids and not
     * necessarily TrPTools accounts, so this resolves either.
     */
    export const bulkRequest = t.Object({
        robloxIds: t.Array(t.Union([t.Integer(), t.String()]), { maxItems: 200 })
    })
    export type bulkRequest = typeof bulkRequest.static

    export const robloxProfile = t.Object({
        robloxId: t.String(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()])
    })
    export const robloxProfileList = t.Array(robloxProfile)
    export type robloxProfileList = typeof robloxProfileList.static

    export const preferencesBody = t.Object({
        theme: t.Optional(t.Union([t.Literal('dim'), t.Literal('midnight'), t.Literal('light')])),
        locale: t.Optional(t.String({ maxLength: 8 })),
        timezone: t.Optional(t.String({ maxLength: 64 })),
        profilePublic: t.Optional(t.Boolean())
    })
    export type preferencesBody = typeof preferencesBody.static

    export const preferencesResponse = t.Object({
        theme: t.String(),
        locale: t.String(),
        timezone: t.String(),
        profilePublic: t.Boolean()
    })
    export type preferencesResponse = typeof preferencesResponse.static

    export const routePreference = t.Union([t.Literal('FAVORITE'), t.Literal('DISLIKE'), t.Literal('NONE')])
    export type routePreference = typeof routePreference.static

    export const routePreferenceItem = t.Object({
        routeId: t.String(),
        groupId: t.String(),
        name: t.String(),
        color: t.String(),
        preference: t.Union([t.Literal('FAVORITE'), t.Literal('DISLIKE')])
    })
    export const routePreferenceList = t.Array(routePreferenceItem)
    export type routePreferenceList = typeof routePreferenceList.static

    export const setRoutePreferenceBody = t.Object({
        preference: routePreference
    })
    export type setRoutePreferenceBody = typeof setRoutePreferenceBody.static

    // ------------------------------------------------------------ site admin

    export const accountBan = t.Object({
        /** False once a suspension has lapsed; the record is kept regardless. */
        active: t.Boolean(),
        reason: t.String(),
        bannedAt: t.Date(),
        /** Null on a permanent ban. */
        expiresAt: t.Union([t.Date(), t.Null()]),
        by: t.Union([
            t.Object({
                userId: t.String(),
                displayName: t.Union([t.String(), t.Null()]),
                username: t.Union([t.String(), t.Null()])
            }),
            t.Null()
        ])
    })
    export type accountBan = typeof accountBan.static

    export const adminUser = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()]),
        siteRank: t.String(),
        createdAt: t.Date(),
        ban: t.Union([accountBan, t.Null()])
    })
    export type adminUser = typeof adminUser.static

    export const adminUserList = t.Array(adminUser)
    export type adminUserList = typeof adminUserList.static

    export const adminListQuery = t.Object({
        /** Matches a username, display name or Roblox id. */
        q: t.Optional(t.String({ maxLength: 100 })),
        status: t.Optional(t.Union([t.Literal('ALL'), t.Literal('BANNED')])),
        limit: t.Optional(t.String())
    })
    export type adminListQuery = typeof adminListQuery.static

    export const banBody = t.Object({
        reason: t.String({ maxLength: 500, default: '' }),
        /**
         * Hours until the suspension lifts. Left out, the ban is permanent —
         * that difference is the whole of "suspend" versus "ban".
         */
        durationHours: t.Optional(t.Integer({ minimum: 1, maximum: 8760 }))
    })
    export type banBody = typeof banBody.static

    export const cannotBanSelf = t.Literal('you cannot suspend your own account')
    export type cannotBanSelf = typeof cannotBanSelf.static

    export const cannotBanAdmin = t.Literal('site administrators cannot be suspended')
    export type cannotBanAdmin = typeof cannotBanAdmin.static
}
