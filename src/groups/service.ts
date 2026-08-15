import { status } from 'elysia'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import db from '../db'
import { auditMessages, groups, rankRelations, users, type Group } from '../db/schema'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { Roblox, type RobloxCredentials } from '../utils/roblox'
import { resolveCredentials, userCredentials } from '../utils/robloxCredentials'
import { encryptSecret } from '../utils/crypto'
import { assertPermission, GetPermissionLevel, invalidateGroupPermissions } from '../utils/groupPermission'
import { isValidSlug, uniqueSlug } from '../utils/slug'
import type { session } from '../utils/sessionVerifier'
import { seedGroupDefaults } from './defaults'
import { GroupModel } from './model'

/** Refreshes the cached Roblox facts on a group if they have gone stale. */
async function withFreshCache(group: Group, credentials: RobloxCredentials): Promise<Group> {
    const stale = !group.cachedAt || Date.now() - group.cachedAt.getTime() > 1000 * 60 * 30
    if (!stale) return group

    const [robloxGroup, icon] = await Promise.all([
        Roblox.getGroup(group.robloxId, credentials),
        Roblox.getGroupIcon(group.robloxId)
    ])

    if (!robloxGroup && !icon) return group

    const patch = {
        cachedName: robloxGroup?.name ?? group.cachedName,
        cachedDescription: robloxGroup?.description ?? group.cachedDescription,
        cachedIcon: icon ?? group.cachedIcon,
        cachedMembers: robloxGroup?.memberCount ?? group.cachedMembers,
        cachedAt: new Date()
    }

    await db.update(groups).set(patch).where(eq(groups.id, group.id)).catch(() => undefined)

    return { ...group, ...patch }
}

function present(group: Group, permissionLevel: number): GroupModel.groupResponse {
    return {
        id: group.id,
        slug: group.slug,
        createdAt: group.createdAt,

        robloxId: group.robloxId,
        name: group.cachedName ?? `Group ${group.robloxId}`,
        description: group.cachedDescription ?? '',
        icon: group.cachedIcon,
        members: group.cachedMembers ?? 0,

        visibility: group.visibility,
        tagline: group.tagline,
        about: group.about,
        accentColor: group.accentColor,
        bannerImage: group.bannerImage,
        bannerMediaId: group.bannerMediaId,

        showRoutes: group.showRoutes,
        showShifts: group.showShifts,
        showRoster: group.showRoster,
        showDispatch: group.showDispatch,
        roomOpenLeadMinutes: group.roomOpenLeadMinutes,

        permissionLevel,
        hasOpenCloudKey: Boolean(group.openCloudKey),
        moderation: group.moderation
    }
}

export function summarise(group: Group, permissionLevel: number): GroupModel.groupSummary {
    return {
        id: group.id,
        slug: group.slug,
        robloxId: group.robloxId,
        name: group.cachedName ?? `Group ${group.robloxId}`,
        icon: group.cachedIcon,
        members: group.cachedMembers ?? 0,
        tagline: group.tagline,
        accentColor: group.accentColor,
        visibility: group.visibility,
        permissionLevel
    }
}

export async function recordAudit(groupId: string, actorId: string | null, action: string, summary: string) {
    await db.insert(auditMessages).values({ groupId, actorId, action, summary }).catch(() => undefined)
}

export abstract class Group_ {
    /** Roblox groups the user owns that are not on TrPTools yet. */
    static async getCreatableGroups(session: session): Promise<GroupModel.creatableGroupList> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const memberships = await Roblox.getUserGroups(session.user.robloxId)
        const owned = memberships.filter((membership) => membership.role.rank >= 255)
        if (owned.length === 0) return []

        const ownedIds = owned.map((membership) => membership.groupId.toString())

        const existing = await db
            .select({ robloxId: groups.robloxId })
            .from(groups)
            .where(inArray(groups.robloxId, ownedIds))

        const taken = new Set(existing.map((row) => row.robloxId))
        const creatable = owned.filter((membership) => !taken.has(membership.groupId.toString()))

        const icons = await Promise.all(creatable.map((membership) => Roblox.getGroupIcon(membership.groupId)))

        return creatable.map((membership, index) => ({
            robloxId: membership.groupId.toString(),
            name: membership.groupName ?? `Group ${membership.groupId}`,
            icon: icons[index] ?? null,
            members: 0
        }))
    }

    /** Every TrPTools group the user can act in. */
    static async getGroups(session: session): Promise<GroupModel.groupList> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        // Site admins operate the instance, so they see every group.
        if (session.user.siteRank === 'admin') {
            const all = await db.select().from(groups).orderBy(asc(groups.cachedName))
            return all.map((entry) => summarise(entry, PERMISSION.MANAGE))
        }

        const memberships = await Roblox.getUserGroups(session.user.robloxId)
        if (memberships.length === 0) return []

        const roleIds = memberships.map((membership) => membership.role.id)

        const rows = await db
            .select({ group: groups, permissionLevel: rankRelations.permissionLevel })
            .from(rankRelations)
            .innerJoin(groups, eq(rankRelations.groupId, groups.id))
            .where(inArray(rankRelations.robloxId, roleIds))

        const visible = rows.filter((row) => row.permissionLevel >= PERMISSION.DISPATCH)

        return visible.map((row) => summarise(row.group, row.permissionLevel))
    }

    static async createGroup(
        { robloxId }: GroupModel.createGroupBody,
        session: session
    ): Promise<GroupModel.createGroupResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const existing = await db.select({ id: groups.id }).from(groups).where(eq(groups.robloxId, robloxId)).limit(1)
        if (existing.length > 0) {
            throw status(409, 'group already exists' satisfies GroupModel.groupExists)
        }

        // Ownership is checked twice: against the user's membership list, and
        // against the group's own owner field. Both have to agree.
        const credentials = await userCredentials(session.user.userId)
        const [memberships, robloxGroup] = await Promise.all([
            Roblox.getUserGroups(session.user.robloxId),
            Roblox.getGroup(robloxId, credentials)
        ])

        if (!robloxGroup) throw status(400, 'group does not exist' satisfies GroupModel.groupInvalid)

        const membership = memberships.find((entry) => entry.groupId.toString() === robloxId)
        const ownsByRank = membership !== undefined && membership.role.rank >= 255
        const ownsByOwnerField = robloxGroup.ownerId === session.user.robloxId

        if (!ownsByRank && !ownsByOwnerField) {
            throw status(403, 'Forbidden' satisfies globalModel.forbidden)
        }

        const roles = await Roblox.getRoles(robloxId, credentials)
        const ownerRole = roles.find((role) => role.rank === 255)
        if (!ownerRole) throw status(400, 'group does not exist' satisfies GroupModel.groupInvalid)

        const slug = await uniqueSlug(robloxGroup.name, `group-${robloxId}`)
        const icon = await Roblox.getGroupIcon(robloxId)

        const [group] = await db
            .insert(groups)
            .values({
                robloxId,
                slug,
                cachedName: robloxGroup.name,
                cachedDescription: robloxGroup.description,
                cachedIcon: icon,
                cachedMembers: robloxGroup.memberCount,
                cachedAt: new Date()
            })
            .returning()

        if (!group) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        // The owner role always starts with full control, otherwise the person
        // who just created the group could not administer it.
        await db.insert(rankRelations).values({
            groupId: group.id,
            robloxId: ownerRole.id,
            color: '#9b59b6',
            visible: true,
            permissionLevel: PERMISSION.MANAGE,
            cachedName: ownerRole.name,
            cachedRank: ownerRole.rank
        })

        // Every group starts with the depots and routes the game itself has.
        await seedGroupDefaults(group.id)

        await recordAudit(group.id, session.user.userId, 'group.create', `Group added to TrPTools`)

        return { id: group.id, slug: group.slug }
    }

    static async getGroup(idOrSlug: string, session: session): Promise<GroupModel.groupResponse> {
        const group = await findGroup(idOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        // Site admins operate the instance, so they always report full access
        // here — matching the bypass `assertPermission` already applies.
        const permissionLevel =
            session.user?.siteRank === 'admin'
                ? PERMISSION.MANAGE
                : session.user
                  ? await GetPermissionLevel(session.user.userId, group.id)
                  : PERMISSION.NONE

        // A private group is only visible to people who hold a rank in it.
        if (group.visibility === 'PRIVATE' && permissionLevel < PERMISSION.DISPATCH) {
            if (session.user?.siteRank !== 'admin') {
                throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)
            }
        }

        const credentials = await resolveCredentials(group.id, session.user?.userId)
        const fresh = await withFreshCache(group, credentials)

        return present(fresh, permissionLevel)
    }

    static async updateGroup(groupId: string, body: GroupModel.updateGroupBody, session: session) {
        await assertPermission(session, groupId, PERMISSION.MANAGE)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        if (body.slug !== undefined && body.slug !== group.slug) {
            if (!isValidSlug(body.slug)) throw status(409, 'slug is unavailable' satisfies GroupModel.slugTaken)

            const clash = await db
                .select({ id: groups.id })
                .from(groups)
                .where(and(eq(groups.slug, body.slug), ne(groups.id, group.id)))
                .limit(1)

            if (clash.length > 0) throw status(409, 'slug is unavailable' satisfies GroupModel.slugTaken)
        }

        await db.update(groups).set(body).where(eq(groups.id, group.id))

        await recordAudit(group.id, session.user?.userId ?? null, 'group.update', 'Group settings updated')

        return 'Success' as globalModel.genericSuccess
    }

    /**
     * Stores the group's Open Cloud API key, but only after proving it can
     * actually read the group. A key that does not work would silently push
     * every permission check down to the slower fallback tiers.
     */
    static async setOpenCloudKey(groupId: string, body: GroupModel.openCloudKeyBody, session: session) {
        await assertPermission(session, groupId, PERMISSION.MANAGE)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        if (body.apiKey === null) {
            await db.update(groups).set({ openCloudKey: null }).where(eq(groups.id, group.id))
            await recordAudit(group.id, session.user?.userId ?? null, 'group.key.remove', 'Open Cloud key removed')
            return 'Success' as globalModel.genericSuccess
        }

        const works = await Roblox.verifyApiKey(group.robloxId, body.apiKey)
        if (!works) throw status(400, 'api key cannot read this group' satisfies GroupModel.invalidKey)

        await db
            .update(groups)
            .set({ openCloudKey: await encryptSecret(body.apiKey) })
            .where(eq(groups.id, group.id))

        await invalidateGroupPermissions(group.id)
        await Roblox.invalidateGroup(group.robloxId)
        await recordAudit(group.id, session.user?.userId ?? null, 'group.key.set', 'Open Cloud key configured')

        return 'Success' as globalModel.genericSuccess
    }

    /** Recent changes, with the person who made each one resolved. */
    static async getAudit(groupIdOrSlug: string, session: session): Promise<GroupModel.auditList> {
        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const rows = await db
            .select({
                id: auditMessages.id,
                action: auditMessages.action,
                summary: auditMessages.summary,
                date: auditMessages.date,
                actorId: users.id,
                actorRobloxId: users.robloxId,
                actorName: users.cachedDisplayName,
                actorUsername: users.cachedUsername,
                actorAvatar: users.cachedAvatar
            })
            .from(auditMessages)
            .leftJoin(users, eq(auditMessages.actorId, users.id))
            .where(eq(auditMessages.groupId, group.id))
            .orderBy(desc(auditMessages.date))
            .limit(100)

        return rows.map((row) => ({
            id: row.id,
            action: row.action,
            summary: row.summary,
            date: row.date,
            actor: row.actorId
                ? {
                      userId: row.actorId,
                      robloxId: row.actorRobloxId ?? 0,
                      displayName: row.actorName,
                      username: row.actorUsername,
                      avatar: row.actorAvatar
                  }
                : null
        }))
    }

    static async deleteGroup(groupId: string, session: session) {
        await assertPermission(session, groupId, PERMISSION.MANAGE)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        // Only the Roblox owner may remove a group outright.
        const credentials = await resolveCredentials(group.id, session.user?.userId)
        const robloxGroup = await Roblox.getGroup(group.robloxId, credentials)

        if (session.user?.siteRank !== 'admin' && robloxGroup?.ownerId !== session.user?.robloxId) {
            throw status(403, 'Forbidden' satisfies globalModel.forbidden)
        }

        await db.delete(groups).where(eq(groups.id, group.id))
        await invalidateGroupPermissions(group.id)

        return 'Success' as globalModel.genericSuccess
    }
}

/** Groups are addressable by uuid or by public slug. */
export async function findGroup(idOrSlug: string): Promise<Group | undefined> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)

    const [group] = await db
        .select()
        .from(groups)
        .where(isUuid ? eq(groups.id, idOrSlug) : eq(groups.slug, idOrSlug))
        .limit(1)

    return group
}
