import { status } from 'elysia'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import db from '../../db'
import { depots, media, routeDepots, routes, type Depot, type Route } from '../../db/schema'
import { globalModel, PERMISSION } from '../../utils/globalModel'
import { assertPermission, GetPermissionLevel } from '../../utils/groupPermission'
import { childSlug, uniqueWithin } from '../../utils/slug'
import { mediaForOwners, mediaUrls } from '../../media/service'
import type { session } from '../../utils/sessionVerifier'
import { findGroup, recordAudit } from '../service'
import { GroupModel } from '../model'
import { RouteModel } from './model'

/** Attaches depot links, the badge image and gallery images to routes. */
async function decorateRoutes(rows: Route[], includeHidden: boolean): Promise<RouteModel.routesResponse> {
    if (rows.length === 0) return []

    const ids = rows.map((route) => route.id)

    const [links, images, icons] = await Promise.all([
        db.select().from(routeDepots).where(inArray(routeDepots.routeId, ids)),
        mediaForOwners('ROUTE', ids, includeHidden),
        mediaUrls(rows.map((route) => route.iconMediaId))
    ])

    const byRoute = new Map<string, string[]>()
    for (const link of links) {
        const bucket = byRoute.get(link.routeId) ?? []
        bucket.push(link.depotId)
        byRoute.set(link.routeId, bucket)
    }

    return rows.map((route) => ({
        ...route,
        icon: route.iconMediaId ? (icons.get(route.iconMediaId) ?? null) : null,
        depots: byRoute.get(route.id) ?? [],
        // The badge lives in the same media table as the gallery, so it is
        // filtered back out rather than appearing twice.
        images: (images.get(route.id) ?? []).filter((image) => image.id !== route.iconMediaId)
    }))
}

async function decorateDepots(rows: Depot[], includeHidden: boolean): Promise<RouteModel.depotList> {
    if (rows.length === 0) return []

    const [images, icons] = await Promise.all([
        mediaForOwners(
            'DEPOT',
            rows.map((depot) => depot.id),
            includeHidden
        ),
        mediaUrls(rows.map((depot) => depot.iconMediaId))
    ])

    return rows.map((depot) => ({
        ...depot,
        icon: depot.iconMediaId ? (icons.get(depot.iconMediaId) ?? null) : null,
        images: (images.get(depot.id) ?? []).filter((image) => image.id !== depot.iconMediaId)
    }))
}

/** A slug free within the group, derived from the name the user chose. */
async function freeRouteSlug(groupId: string, name: string, exceptId?: string): Promise<string> {
    const rows = await db
        .select({ id: routes.id, slug: routes.slug })
        .from(routes)
        .where(eq(routes.groupId, groupId))

    const taken = new Set(rows.filter((row) => row.id !== exceptId).map((row) => row.slug))

    return uniqueWithin(childSlug('route', name, rows.length + 1), taken)
}

async function freeDepotSlug(groupId: string, name: string, number: number, exceptId?: string): Promise<string> {
    const rows = await db
        .select({ id: depots.id, slug: depots.slug })
        .from(depots)
        .where(eq(depots.groupId, groupId))

    const taken = new Set(rows.filter((row) => row.id !== exceptId).map((row) => row.slug))

    return uniqueWithin(childSlug('depot', name, number), taken)
}

/**
 * Rejects a badge that belongs to someone else.
 *
 * The id arrives from the client, so without this a manager could point their
 * own route at another group's image and keep it alive after that group
 * deleted it.
 */
async function assertOwnsMedia(mediaId: string, groupId: string, ownerId: string) {
    const [row] = await db
        .select({ id: media.id })
        .from(media)
        .where(and(eq(media.id, mediaId), eq(media.groupId, groupId), eq(media.ownerId, ownerId)))
        .limit(1)

    if (!row) throw status(404, 'Not Found' satisfies globalModel.notFound)
}

/** Replaces a route's depot links, rejecting depots from other groups. */
async function setDepots(routeId: string, groupId: string, depotIds: string[]) {
    await db.delete(routeDepots).where(eq(routeDepots.routeId, routeId))
    if (depotIds.length === 0) return

    const valid = await db
        .select({ id: depots.id })
        .from(depots)
        .where(and(eq(depots.groupId, groupId), inArray(depots.id, depotIds)))

    if (valid.length === 0) return

    await db.insert(routeDepots).values(valid.map((depot) => ({ routeId, depotId: depot.id })))
}

/** Resolves the group and what the caller is allowed to see of it. */
async function readContext(groupIdOrSlug: string, session: session) {
    const group = await findGroup(groupIdOrSlug)
    if (!group) throw status(404, 'Not Found' satisfies globalModel.notFound)

    const permissionLevel = session.user ? await GetPermissionLevel(session.user.userId, group.id) : PERMISSION.NONE
    const isStaff = permissionLevel >= PERMISSION.DISPATCH || session.user?.siteRank === 'admin'

    return { group, permissionLevel, isStaff }
}

export abstract class Route_ {
    static async getAllRoutes(
        groupIdOrSlug: string,
        includeArchived: boolean,
        session: session
    ): Promise<RouteModel.routesResponse> {
        const { group, isStaff } = await readContext(groupIdOrSlug, session)

        if (!isStaff && (group.visibility === 'PRIVATE' || !group.showRoutes || group.moderation === 'HIDDEN')) {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const rows = await db
            .select()
            .from(routes)
            .where(eq(routes.groupId, group.id))
            .orderBy(asc(routes.order), asc(routes.name))

        const filtered = rows.filter((route) => {
            if (!includeArchived && route.archived) return false
            if (isStaff) return true
            // Withheld content stays off the public view entirely.
            return route.visibility === 'PUBLIC' && route.moderation !== 'HIDDEN'
        })

        return decorateRoutes(filtered, isStaff)
    }

    static async getRoute(routeId: string, session: session): Promise<RouteModel.routeBody> {
        const [route] = await db.select().from(routes).where(eq(routes.id, routeId)).limit(1)
        if (!route) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const { group, isStaff } = await readContext(route.groupId, session)

        if (!isStaff) {
            const hidden =
                group.visibility === 'PRIVATE' ||
                !group.showRoutes ||
                route.visibility !== 'PUBLIC' ||
                route.moderation === 'HIDDEN'

            if (hidden) throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const [decorated] = await decorateRoutes([route], isStaff)
        if (!decorated) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return decorated
    }

    static async createRoute(body: RouteModel.createRouteBody, session: session): Promise<RouteModel.routeIdResponse> {
        const group = await findGroup(body.groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const clash = await db
            .select({ id: routes.id })
            .from(routes)
            .where(and(eq(routes.groupId, group.id), eq(routes.name, body.name)))
            .limit(1)

        if (clash.length > 0) {
            throw status(409, 'a route with that name already exists' satisfies RouteModel.nameTaken)
        }

        const { depots: depotIds, groupId, ...values } = body

        const [route] = await db
            .insert(routes)
            .values({ ...values, groupId: group.id, slug: await freeRouteSlug(group.id, body.name) })
            .returning({ id: routes.id })

        if (!route) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        if (depotIds?.length) await setDepots(route.id, group.id, depotIds)

        await recordAudit(group.id, session.user?.userId ?? null, 'route.create', `Created route ${body.name}`)

        return { id: route.id }
    }

    static async updateRoute(routeId: string, body: RouteModel.patchRouteBody, session: session) {
        const [route] = await db.select().from(routes).where(eq(routes.id, routeId)).limit(1)
        if (!route) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, route.groupId, PERMISSION.MANAGE)

        const patch = { ...body }

        // Built-in routes exist in the game itself, so their identity is fixed.
        // Everything else about them — colour, share, depots, archived — is the
        // group's to change.
        if (route.builtIn) delete patch.name

        if (patch.name !== undefined && patch.name !== route.name) {
            const clash = await db
                .select({ id: routes.id })
                .from(routes)
                .where(and(eq(routes.groupId, route.groupId), eq(routes.name, patch.name), ne(routes.id, routeId)))
                .limit(1)

            if (clash.length > 0) {
                throw status(409, 'a route with that name already exists' satisfies RouteModel.nameTaken)
            }
        }

        if (patch.iconMediaId) await assertOwnsMedia(patch.iconMediaId, route.groupId, routeId)

        const { depots: depotIds, ...fields } = patch

        if (Object.keys(fields).length > 0) {
            await db
                .update(routes)
                .set({
                    ...fields,
                    // The page address follows the name, so a rename does not
                    // leave the URL describing something else.
                    ...(fields.name !== undefined && fields.name !== route.name
                        ? { slug: await freeRouteSlug(route.groupId, fields.name, routeId) }
                        : {}),
                    updatedAt: new Date()
                })
                .where(eq(routes.id, routeId))
        }

        if (depotIds !== undefined) await setDepots(routeId, route.groupId, depotIds)

        await recordAudit(route.groupId, session.user?.userId ?? null, 'route.update', `Updated route ${route.name}`)

        return 'Success' as globalModel.genericSuccess
    }

    static async deleteRoute(routeId: string, session: session) {
        const [route] = await db.select().from(routes).where(eq(routes.id, routeId)).limit(1)
        if (!route) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, route.groupId, PERMISSION.MANAGE)

        if (route.builtIn) {
            throw status(
                403,
                'built-in routes can be disabled but not deleted' satisfies RouteModel.builtInProtected
            )
        }

        await db.delete(routes).where(eq(routes.id, routeId))

        await recordAudit(route.groupId, session.user?.userId ?? null, 'route.delete', `Deleted route ${route.name}`)

        return 'Success' as globalModel.genericSuccess
    }
}

export abstract class Depot_ {
    static async list(
        groupIdOrSlug: string,
        includeArchived: boolean,
        session: session
    ): Promise<RouteModel.depotList> {
        const { group, isStaff } = await readContext(groupIdOrSlug, session)

        if (!isStaff && (group.visibility === 'PRIVATE' || group.moderation === 'HIDDEN')) {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const rows = await db
            .select()
            .from(depots)
            .where(eq(depots.groupId, group.id))
            .orderBy(asc(depots.order), asc(depots.number))

        const filtered = rows.filter((depot) => {
            if (!includeArchived && depot.archived) return false
            if (isStaff) return true
            return depot.visibility === 'PUBLIC' && depot.moderation !== 'HIDDEN'
        })

        return decorateDepots(filtered, isStaff)
    }

    static async get(depotId: string, session: session): Promise<RouteModel.depotBody> {
        const [depot] = await db.select().from(depots).where(eq(depots.id, depotId)).limit(1)
        if (!depot) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const { isStaff } = await readContext(depot.groupId, session)

        if (!isStaff && (depot.visibility !== 'PUBLIC' || depot.moderation === 'HIDDEN')) {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const [decorated] = await decorateDepots([depot], isStaff)
        if (!decorated) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return decorated
    }

    static async create(body: RouteModel.createDepotBody, session: session) {
        const group = await findGroup(body.groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const clash = await db
            .select({ id: depots.id })
            .from(depots)
            .where(and(eq(depots.groupId, group.id), eq(depots.number, body.number)))
            .limit(1)

        if (clash.length > 0) {
            throw status(409, 'a depot with that number already exists' satisfies RouteModel.numberTaken)
        }

        const { groupId, ...values } = body

        const [depot] = await db
            .insert(depots)
            .values({
                ...values,
                groupId: group.id,
                slug: await freeDepotSlug(group.id, body.name, body.number)
            })
            .returning({ id: depots.id })

        if (!depot) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        await recordAudit(group.id, session.user?.userId ?? null, 'depot.create', `Created depot ${body.number}`)

        return { id: depot.id }
    }

    static async update(depotId: string, body: RouteModel.patchDepotBody, session: session) {
        const [depot] = await db.select().from(depots).where(eq(depots.id, depotId)).limit(1)
        if (!depot) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, depot.groupId, PERMISSION.MANAGE)

        if (body.number !== undefined && body.number !== depot.number) {
            const clash = await db
                .select({ id: depots.id })
                .from(depots)
                .where(
                    and(
                        eq(depots.groupId, depot.groupId),
                        eq(depots.number, body.number),
                        ne(depots.id, depotId)
                    )
                )
                .limit(1)

            if (clash.length > 0) {
                throw status(409, 'a depot with that number already exists' satisfies RouteModel.numberTaken)
            }
        }

        if (body.iconMediaId) await assertOwnsMedia(body.iconMediaId, depot.groupId, depotId)

        if (Object.keys(body).length > 0) {
            await db
                .update(depots)
                .set({
                    ...body,
                    ...(body.name !== undefined && body.name !== depot.name
                        ? {
                              slug: await freeDepotSlug(
                                  depot.groupId,
                                  body.name,
                                  body.number ?? depot.number,
                                  depotId
                              )
                          }
                        : {}),
                    updatedAt: new Date()
                })
                .where(eq(depots.id, depotId))
        }

        await recordAudit(depot.groupId, session.user?.userId ?? null, 'depot.update', `Updated depot ${depot.number}`)

        return 'Success' as globalModel.genericSuccess
    }

    static async remove(depotId: string, session: session) {
        const [depot] = await db.select().from(depots).where(eq(depots.id, depotId)).limit(1)
        if (!depot) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await assertPermission(session, depot.groupId, PERMISSION.MANAGE)

        await db.delete(depots).where(eq(depots.id, depotId))

        await recordAudit(depot.groupId, session.user?.userId ?? null, 'depot.delete', `Deleted depot ${depot.number}`)

        return 'Success' as globalModel.genericSuccess
    }
}
