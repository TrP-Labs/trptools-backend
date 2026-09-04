import { t } from 'elysia'

export namespace UserModel {
    /**
     * A route as it appears on somebody's profile.
     *
     * Enough to draw the badge and link to the route's own page, and nothing
     * else — a profile is not a route catalogue. Routes a group has not
     * published never reach here, so the lists say no more than the group
     * already does.
     */
    export const profileRoute = t.Object({
        /** Null for a global route: the mark is against the name, not a row. */
        routeId: t.Union([t.String(), t.Null()]),
        name: t.String(),
        color: t.String(),
        textColor: t.String(),
        shape: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        /**
         * True for one of the routes the game ships with, which is the same
         * route in every group. It carries no group and links nowhere,
         * because there is no one page that is *the* page for it.
         */
        global: t.Boolean(),
        groupSlug: t.Union([t.String(), t.Null()]),
        groupName: t.Union([t.String(), t.Null()]),
        routeSlug: t.Union([t.String(), t.Null()])
    })
    export type profileRoute = typeof profileRoute.static

    export const publicProfile = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()]),
        siteRank: t.String(),

        /**
         * The published half of this person's route preferences.
         *
         * Null rather than an empty array when the section is switched off, so
         * a profile with nothing marked and a profile keeping it to itself do
         * not look the same to the page drawing them.
         */
        favoriteRoutes: t.Union([t.Array(profileRoute), t.Null()]),
        dislikedRoutes: t.Union([t.Array(profileRoute), t.Null()])
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

    /**
     * Nothing here carries a `default`. Elysia injects one into the parsed
     * body, so a default on an optional field turns every PATCH into an edit
     * of that field — a request saying only "change my timezone" would also
     * silently republish a profile its owner had hidden.
     */
    export const preferencesBody = t.Object({
        theme: t.Optional(t.Union([t.Literal('dim'), t.Literal('midnight'), t.Literal('light')])),
        /** Null clears the preference back to following the browser. */
        locale: t.Optional(t.Union([t.String({ maxLength: 8 }), t.Null()])),
        timezone: t.Optional(t.String({ maxLength: 64 })),
        profilePublic: t.Optional(t.Boolean()),
        favoriteRoutesPublic: t.Optional(t.Boolean()),
        dislikedRoutesPublic: t.Optional(t.Boolean()),
        /** Null clears the pin. A group the caller cannot act in is refused. */
        primaryGroupId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()]))
    })
    export type preferencesBody = typeof preferencesBody.static

    export const preferencesResponse = t.Object({
        theme: t.String(),
        locale: t.Union([t.String(), t.Null()]),
        timezone: t.String(),
        profilePublic: t.Boolean(),
        favoriteRoutesPublic: t.Boolean(),
        dislikedRoutesPublic: t.Boolean(),
        primaryGroupId: t.Union([t.String(), t.Null()])
    })
    export type preferencesResponse = typeof preferencesResponse.static

    export const routePreference = t.Union([t.Literal('FAVORITE'), t.Literal('DISLIKE'), t.Literal('NONE')])
    export type routePreference = typeof routePreference.static

    /**
     * One mark, either against a single custom route or against a built-in
     * route's name everywhere.
     *
     * A global item carries the name and no ids, because there is no single
     * row it belongs to — the reader matches it against any built-in route
     * with that name.
     */
    export const routePreferenceItem = t.Object({
        global: t.Boolean(),
        routeId: t.Union([t.String(), t.Null()]),
        groupId: t.Union([t.String(), t.Null()]),
        name: t.String(),
        color: t.String(),
        preference: t.Union([t.Literal('FAVORITE'), t.Literal('DISLIKE')])
    })
    export type routePreferenceItem = typeof routePreferenceItem.static
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
