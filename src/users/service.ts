import { status } from 'elysia'
import { and, desc, eq, gt, ilike, isNotNull, isNull, ne, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import db from '../db'
import { globalRoutePreferences, groups, routePreferences, routes, users } from '../db/schema'
import { BUILT_IN_ROUTES } from '../groups/defaults'
import { mediaUrls } from '../media/service'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { assertPermission } from '../utils/groupPermission'
import { requireSiteAdmin } from '../utils/authPlugin'
import { isBanned } from '../utils/moderation'
import { Roblox } from '../utils/roblox'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { Session } from '../auth/service'
import { UserModel } from './model'

export abstract class UserService {
    static async getProfile(userId: string, session: session): Promise<UserModel.publicProfile> {
        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
        if (!user) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const isSelf = session.user?.userId === user.id
        if (!user.profilePublic && !isSelf && !isSiteAdmin(session)) {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const stale = !user.cachedAt || Date.now() - user.cachedAt.getTime() > 1000 * 60 * 60 * 12
        if (stale) void Session.RefreshIdentity(user.id, user.robloxId)

        // Whether the *owner* is reading decides nothing here: a profile shows
        // its owner exactly what everybody else sees, so the visibility
        // switches in settings can be checked by looking at the page.
        const [favorites, disliked] = await Promise.all([
            user.favoriteRoutesPublic ? UserService.publishedRoutes(user.id, 'FAVORITE') : null,
            user.dislikedRoutesPublic ? UserService.publishedRoutes(user.id, 'DISLIKE') : null
        ])

        return {
            userId: user.id,
            robloxId: user.robloxId,
            username: user.cachedUsername,
            displayName: user.cachedDisplayName,
            avatar: user.cachedAvatar,
            siteRank: user.siteRank,
            favoriteRoutes: favorites,
            dislikedRoutes: disliked
        }
    }

    /**
     * The routes somebody has marked, filtered to what their groups publish.
     *
     * A preference can be held against any route the person can reach, which
     * includes routes inside a private group and routes a group has withdrawn
     * from its public pages. Listing those on a profile would publish them on
     * that group's behalf, so the same conditions the public pages apply are
     * applied again here.
     */
    private static async publishedRoutes(
        userId: string,
        preference: 'FAVORITE' | 'DISLIKE'
    ): Promise<UserModel.profileRoute[]> {
        const rows = await db
            .select({
                routeId: routes.id,
                name: routes.name,
                color: routes.color,
                textColor: routes.textColor,
                shape: routes.shape,
                iconMediaId: routes.iconMediaId,
                routeSlug: routes.slug,
                groupSlug: groups.slug,
                groupName: groups.cachedName,
                groupRobloxId: groups.robloxId
            })
            .from(routePreferences)
            .innerJoin(routes, eq(routePreferences.routeId, routes.id))
            .innerJoin(groups, eq(routes.groupId, groups.id))
            .where(
                and(
                    eq(routePreferences.userId, userId),
                    eq(routePreferences.preference, preference),
                    // Built-ins are held globally; a stale row from before
                    // that must not list the same route once per group.
                    eq(routes.builtIn, false),
                    eq(routes.archived, false),
                    eq(routes.visibility, 'PUBLIC'),
                    ne(routes.moderation, 'HIDDEN'),
                    // UNLISTED groups stay reachable by direct link, and a
                    // profile is exactly such a link.
                    ne(groups.visibility, 'PRIVATE'),
                    ne(groups.moderation, 'HIDDEN')
                )
            )

        const [icons, global] = await Promise.all([
            mediaUrls(rows.map((row) => row.iconMediaId)),
            db
                .select({ routeName: globalRoutePreferences.routeName })
                .from(globalRoutePreferences)
                .where(
                    and(
                        eq(globalRoutePreferences.userId, userId),
                        eq(globalRoutePreferences.preference, preference)
                    )
                )
        ])

        /**
         * A global route is drawn in the game's own colours.
         *
         * Each group's copy carries its own, and there is no reason to prefer
         * one group's paint job over another's on a page that is about the
         * route rather than about any group running it.
         */
        const globalRoutes: UserModel.profileRoute[] = global
            .map((row) => {
                const preset = BUILT_IN_ROUTES.find((route) => route.name === row.routeName)
                return {
                    routeId: null,
                    name: row.routeName,
                    color: preset?.color ?? '#4287f5',
                    textColor: '#111111',
                    shape: 'AUTO',
                    icon: null,
                    global: true,
                    groupSlug: null,
                    groupName: null,
                    routeSlug: null
                }
            })
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

        return [
            ...globalRoutes,
            ...rows.map((row) => ({
                routeId: row.routeId,
                name: row.name,
                color: row.color,
                textColor: row.textColor,
                shape: row.shape,
                icon: row.iconMediaId ? (icons.get(row.iconMediaId) ?? null) : null,
                global: false,
                groupSlug: row.groupSlug,
                groupName: row.groupName ?? `Group ${row.groupRobloxId}`,
                routeSlug: row.routeSlug
            }))
        ]
    }

    /** Resolves Roblox identities in bulk, cached, for the dispatch table. */
    static async resolveRoblox(body: UserModel.bulkRequest): Promise<UserModel.robloxProfileList> {
        const ids = body.robloxIds.map((id) => id.toString())
        if (ids.length === 0) return []

        const [profiles, avatars] = await Promise.all([Roblox.getUsers(ids), Roblox.getAvatars(ids)])

        return [...new Set(ids)].map((id) => ({
            robloxId: id,
            username: profiles.get(id)?.name ?? null,
            displayName: profiles.get(id)?.displayName ?? null,
            avatar: avatars.get(id) ?? null
        }))
    }

    static async getPreferences(session: session): Promise<UserModel.preferencesResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [user] = await db
            .select({
                theme: users.theme,
                locale: users.locale,
                timezone: users.timezone,
                profilePublic: users.profilePublic,
                favoriteRoutesPublic: users.favoriteRoutesPublic,
                dislikedRoutesPublic: users.dislikedRoutesPublic,
                primaryGroupId: users.primaryGroupId
            })
            .from(users)
            .where(eq(users.id, session.user.userId))
            .limit(1)

        if (!user) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return user
    }

    static async setPreferences(body: UserModel.preferencesBody, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        // Pinning a group is a shortcut, not a grant — but a shortcut to a
        // group you cannot open is a broken link on your own dashboard, so the
        // pin is checked against the same permission the link leads to.
        if (body.primaryGroupId) {
            await assertPermission(session, body.primaryGroupId, PERMISSION.DISPATCH)
        }

        if (Object.keys(body).length > 0) {
            await db.update(users).set(body).where(eq(users.id, session.user.userId))
        }

        return 'Success' as globalModel.genericSuccess
    }

    static async getRoutePreferences(session: session): Promise<UserModel.routePreferenceList> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const userId = session.user.userId

        const [custom, global] = await Promise.all([
            db
                .select({
                    routeId: routes.id,
                    groupId: routes.groupId,
                    name: routes.name,
                    color: routes.color,
                    preference: routePreferences.preference
                })
                .from(routePreferences)
                .innerJoin(routes, eq(routePreferences.routeId, routes.id))
                .where(eq(routePreferences.userId, userId)),
            db
                .select({
                    name: globalRoutePreferences.routeName,
                    preference: globalRoutePreferences.preference
                })
                .from(globalRoutePreferences)
                .where(eq(globalRoutePreferences.userId, userId))
        ])

        return [
            // A global mark is sent once, by name. Expanding it into a row per
            // group would grow with the site and still miss the group that
            // registers next.
            ...global.map((row) => ({
                global: true,
                routeId: null,
                groupId: null,
                name: row.name,
                color: BUILT_IN_ROUTES.find((route) => route.name === row.name)?.color ?? '#4287f5',
                preference: row.preference
            })),
            ...custom.map((row) => ({ global: false, ...row }))
        ]
    }

    /**
     * Marks a route as wanted or unwanted. The dispatch solver reads these to
     * put drivers on routes they actually like when it can.
     */
    static async setRoutePreference(routeId: string, body: UserModel.setRoutePreferenceBody, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [route] = await db
            .select({ id: routes.id, name: routes.name, builtIn: routes.builtIn })
            .from(routes)
            .where(eq(routes.id, routeId))
            .limit(1)
        if (!route) throw status(404, 'Not Found' satisfies globalModel.notFound)

        /**
         * Marking one group's route 6 marks route 6.
         *
         * The route is addressed by the id of the copy the person was looking
         * at — that is what the page in front of them has — but a built-in is
         * the same route in every group, so the answer is stored against its
         * name and applies wherever it is run. A custom route is that group's
         * own invention, and two groups running a "15" do not mean the same
         * thing by it.
         */
        if (route.builtIn) {
            if (body.preference === 'NONE') {
                await db
                    .delete(globalRoutePreferences)
                    .where(
                        and(
                            eq(globalRoutePreferences.userId, session.user.userId),
                            eq(globalRoutePreferences.routeName, route.name)
                        )
                    )

                return 'Success' as globalModel.genericSuccess
            }

            await db
                .insert(globalRoutePreferences)
                .values({ userId: session.user.userId, routeName: route.name, preference: body.preference })
                .onConflictDoUpdate({
                    target: [globalRoutePreferences.userId, globalRoutePreferences.routeName],
                    set: { preference: body.preference }
                })

            return 'Success' as globalModel.genericSuccess
        }

        if (body.preference === 'NONE') {
            await db
                .delete(routePreferences)
                .where(and(eq(routePreferences.userId, session.user.userId), eq(routePreferences.routeId, routeId)))

            return 'Success' as globalModel.genericSuccess
        }

        await db
            .insert(routePreferences)
            .values({ userId: session.user.userId, routeId, preference: body.preference })
            .onConflictDoUpdate({
                target: [routePreferences.userId, routePreferences.routeId],
                set: { preference: body.preference }
            })

        return 'Success' as globalModel.genericSuccess
    }
}

/**
 * Suspending an account, from the site admin portal.
 *
 * A suspension and a ban are the same record with and without an expiry, so
 * there is one code path and one place a mistake can hide. Enforcement is not
 * here: `sessionVerifier` refuses to resolve a suspended account on any route,
 * and the OAuth callback refuses to issue it a fresh session.
 */
export abstract class UserModeration {
    static async list(query: UserModel.adminListQuery, session: session): Promise<UserModel.adminUserList> {
        requireSiteAdmin(session)

        const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200)
        const term = query.q?.trim() ?? ''
        const filters = []

        if (term) {
            const like = `%${term}%`
            filters.push(
                or(
                    ilike(users.cachedUsername, like),
                    ilike(users.cachedDisplayName, like),
                    // Roblox ids are how an admin identifies someone whose
                    // display name has since changed.
                    /^\d+$/.test(term) ? eq(users.robloxId, Number(term)) : undefined
                )
            )
        }

        if (query.status === 'BANNED') {
            filters.push(
                and(
                    isNotNull(users.bannedAt),
                    or(isNull(users.banExpiresAt), gt(users.banExpiresAt, new Date()))
                )
            )
        }

        const moderator = alias(users, 'moderator')

        const rows = await db
            .select({ user: users, moderator })
            .from(users)
            .leftJoin(moderator, eq(users.bannedBy, moderator.id))
            .where(filters.length > 0 ? and(...filters) : undefined)
            .orderBy(query.status === 'BANNED' ? desc(users.bannedAt) : desc(users.createdAt))
            .limit(limit)

        return rows.map(({ user, moderator: by }) => ({
            userId: user.id,
            robloxId: user.robloxId,
            username: user.cachedUsername,
            displayName: user.cachedDisplayName,
            avatar: user.cachedAvatar,
            siteRank: user.siteRank,
            createdAt: user.createdAt,
            ban: user.bannedAt
                ? {
                      active: isBanned(user),
                      reason: user.banReason,
                      bannedAt: user.bannedAt,
                      expiresAt: user.banExpiresAt,
                      by: by ? { userId: by.id, displayName: by.cachedDisplayName, username: by.cachedUsername } : null
                  }
                : null
        }))
    }

    static async ban(userId: string, body: UserModel.banBody, session: session) {
        const admin = requireSiteAdmin(session)

        if (userId === admin.userId) {
            throw status(400, 'you cannot suspend your own account' satisfies UserModel.cannotBanSelf)
        }

        const [target] = await db
            .select({ id: users.id, siteRank: users.siteRank })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)

        if (!target) throw status(404, 'Not Found' satisfies globalModel.notFound)

        // Lifting a ban needs an admin, so admins banning each other is how the
        // site ends up with nobody able to administer it.
        if (target.siteRank === 'admin') {
            throw status(403, 'site administrators cannot be suspended' satisfies UserModel.cannotBanAdmin)
        }

        await db
            .update(users)
            .set({
                bannedAt: new Date(),
                banExpiresAt: body.durationHours
                    ? new Date(Date.now() + body.durationHours * 60 * 60 * 1000)
                    : null,
                banReason: body.reason,
                bannedBy: admin.userId
            })
            .where(eq(users.id, userId))

        // Access has to stop now rather than whenever the cookie happens to
        // expire, and a signed-in tab would otherwise carry on until then.
        await Session.DestroyAll(userId)

        return 'Success' as globalModel.genericSuccess
    }

    static async unban(userId: string, session: session) {
        requireSiteAdmin(session)

        const lifted = await db
            .update(users)
            .set({ bannedAt: null, banExpiresAt: null, banReason: '', bannedBy: null })
            .where(eq(users.id, userId))
            .returning({ id: users.id })

        if (lifted.length === 0) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return 'Success' as globalModel.genericSuccess
    }
}
