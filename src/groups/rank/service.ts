import { status } from 'elysia'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import db from '../../db'
import { rankRelations, rankSignups, rankSignupSlots } from '../../db/schema'
import { globalModel, PERMISSION } from '../../utils/globalModel'
import UserHasRank, { assertPermission, invalidateGroupPermissions } from '../../utils/groupPermission'
import { Roblox } from '../../utils/roblox'
import { resolveCredentials } from '../../utils/robloxCredentials'
import { isSiteAdmin, type session } from '../../utils/sessionVerifier'
import { presentTranslations, translationUpdate } from '../../utils/translations'
import { findGroup, recordAudit } from '../service'
import { GroupModel } from '../model'
import { RankModel } from './model'

/** A rank's sheet with its slots, or null where the rank has never had one. */
async function presentSignup(rankId: string): Promise<RankModel.signupOrNull> {
    const [sheet] = await db.select().from(rankSignups).where(eq(rankSignups.rankId, rankId)).limit(1)
    if (!sheet) return null

    const slots = await db
        .select()
        .from(rankSignupSlots)
        .where(eq(rankSignupSlots.signupId, sheet.id))
        .orderBy(asc(rankSignupSlots.order))

    return {
        id: sheet.id,
        rankId: sheet.rankId,
        enabled: sheet.enabled,
        name: sheet.name,
        description: sheet.description,
        translations: presentTranslations('SHEET', sheet.translations),
        color: sheet.color,
        discordChannel: sheet.discordChannel,
        discordPingRole: sheet.discordPingRole,
        slots: slots.map((slot) => ({
            id: slot.id,
            name: slot.name,
            description: slot.description,
            translations: presentTranslations('SLOT', slot.translations),
            capacity: slot.capacity,
            order: slot.order
        }))
    }
}

/**
 * Replaces a sheet's slots wholesale, reusing rows whose name is unchanged.
 *
 * Reuse is what keeps existing sign-ups attached: dropping and recreating the
 * slots would cascade every signup on every future occurrence away because
 * someone renamed the sheet's colour.
 */
async function replaceSignupSlots(signupId: string, slots: RankModel.signupSlotInput[]) {
    const existing = await db.select().from(rankSignupSlots).where(eq(rankSignupSlots.signupId, signupId))
    const byName = new Map(existing.map((slot) => [slot.name, slot]))
    const keep = new Set<string>()

    for (const [index, slot] of slots.entries()) {
        const match = byName.get(slot.name)
        const values = {
            name: slot.name,
            description: slot.description ?? '',
            // Reuse is by name, so a row that survives keeps whatever it had
            // for any field this save does not mention.
            ...translationUpdate('SLOT', match?.translations, slot.translations),
            capacity: slot.capacity ?? 1,
            order: slot.order ?? index
        }

        if (match) {
            keep.add(match.id)
            await db.update(rankSignupSlots).set(values).where(eq(rankSignupSlots.id, match.id))
        } else {
            const [created] = await db
                .insert(rankSignupSlots)
                .values({ signupId, ...values })
                .returning({ id: rankSignupSlots.id })
            if (created) keep.add(created.id)
        }
    }

    const removed = existing.filter((slot) => !keep.has(slot.id))
    if (removed.length > 0) {
        await db.delete(rankSignupSlots).where(
            inArray(
                rankSignupSlots.id,
                removed.map((slot) => slot.id)
            )
        )
    }
}

export abstract class Rank {
    static async getAllRanks(groupId: string, session: session): Promise<RankModel.rankListResponse> {
        await assertPermission(session, groupId, PERMISSION.MANAGE)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const ranks = await db
            .select()
            .from(rankRelations)
            .where(eq(rankRelations.groupId, group.id))
            .orderBy(asc(rankRelations.cachedRank))

        // The Roblox owner role holds manage whatever the row says, so a row
        // that disagrees is repaired here rather than left to show the wrong
        // level forever. Editing rank 255 deliberately drops any permission
        // change, so this is the only place such a row can be corrected.
        const drifted = ranks.filter((rank) => rank.cachedRank >= 255 && rank.permissionLevel !== PERMISSION.MANAGE)

        for (const rank of drifted) {
            await db
                .update(rankRelations)
                .set({ permissionLevel: PERMISSION.MANAGE })
                .where(eq(rankRelations.id, rank.id))
            rank.permissionLevel = PERMISSION.MANAGE
        }

        if (drifted.length > 0) await invalidateGroupPermissions(group.id)

        return ranks
    }

    static async getRank(rankId: string, session: session): Promise<RankModel.rankItemResponse> {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertPermission(session, rank.groupId, PERMISSION.MANAGE)

        return rank
    }

    static async bindRank(
        groupId: string,
        robloxRoleId: string,
        session: session
    ): Promise<RankModel.createRankResponse> {
        await assertPermission(session, groupId, PERMISSION.MANAGE)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const existing = await db
            .select({ id: rankRelations.id })
            .from(rankRelations)
            .where(and(eq(rankRelations.groupId, group.id), eq(rankRelations.robloxId, robloxRoleId)))
            .limit(1)

        if (existing.length > 0) throw status(409, 'rank already exists' satisfies RankModel.rankExists)

        const credentials = await resolveCredentials(group.id, session.user?.userId)
        const role = await Roblox.getRoleById(group.robloxId, robloxRoleId, credentials)
        if (!role) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        const [rank] = await db
            .insert(rankRelations)
            .values({
                groupId: group.id,
                robloxId: role.id,
                cachedName: role.name,
                cachedRank: role.rank,
                color: '#9b59b6',
                visible: false,
                permissionLevel: PERMISSION.NONE
            })
            .returning({ id: rankRelations.id })

        if (!rank) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        await invalidateGroupPermissions(group.id)
        await recordAudit(group.id, session.user?.userId ?? null, 'rank.bind', `Bound rank ${role.name}`)

        return { id: rank.id }
    }

    static async editRank(rankId: string, modification: RankModel.editRankBody, session: session) {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertPermission(session, rank.groupId, PERMISSION.MANAGE)

        const { refresh, ...patch } = modification

        // The Roblox owner role always keeps full control. Without this, an
        // administrator could demote the owner and lock everyone out.
        if (rank.cachedRank === 255) {
            delete (patch as { permissionLevel?: number }).permissionLevel
        }

        const update: Record<string, unknown> = { ...patch }

        if (refresh) {
            const group = await findGroup(rank.groupId)
            if (group) {
                const credentials = await resolveCredentials(group.id, session.user?.userId)
                const role = await Roblox.getRoleById(group.robloxId, rank.robloxId, credentials)
                if (role) {
                    update.cachedName = role.name
                    update.cachedRank = role.rank
                }
            }
        }

        if (Object.keys(update).length > 0) {
            await db.update(rankRelations).set(update).where(eq(rankRelations.id, rankId))
        }

        await invalidateGroupPermissions(rank.groupId)
        await recordAudit(rank.groupId, session.user?.userId ?? null, 'rank.update', `Updated rank ${rank.cachedName}`)

        return 'Success' as globalModel.genericSuccess
    }

    static async unbindRank(rankId: string, session: session) {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertPermission(session, rank.groupId, PERMISSION.MANAGE)

        if (rank.cachedRank === 255) throw status(403, 'Forbidden' satisfies globalModel.forbidden)

        await db.delete(rankRelations).where(eq(rankRelations.id, rankId))

        await invalidateGroupPermissions(rank.groupId)
        await recordAudit(rank.groupId, session.user?.userId ?? null, 'rank.unbind', `Unbound rank ${rank.cachedName}`)

        return 'Success' as globalModel.genericSuccess
    }

    /**
     * The public roster: who holds each rank a group has chosen to show.
     *
     * This is what "show on public roster" controls. Ranks are ordered highest
     * first, and members are capped so a group with thousands of members does
     * not produce an enormous response.
     */
    static async getRoster(groupIdOrSlug: string, session: session): Promise<RankModel.rosterResponse> {
        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const isStaff =
            isSiteAdmin(session) ||
            (session.user ? await UserHasRank(session.user.userId, group.id, PERMISSION.DISPATCH) : false)

        if (!isStaff && (group.visibility === 'PRIVATE' || !group.showRoster || group.moderation === 'HIDDEN')) {
            throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)
        }

        const visible = await db
            .select()
            .from(rankRelations)
            .where(and(eq(rankRelations.groupId, group.id), eq(rankRelations.visible, true)))
            .orderBy(desc(rankRelations.cachedRank))

        if (visible.length === 0) return []

        const rosters = await Promise.all(
            visible.map(async (rank) => {
                const { total, members } = await Roblox.getRoleMembers(group.robloxId, rank.robloxId)
                const avatars = await Roblox.getAvatars(members.map((member) => member.userId))

                return {
                    rankId: rank.id,
                    name: rank.cachedName,
                    description: rank.description,
                    color: rank.color,
                    rank: rank.cachedRank,
                    memberCount: total,
                    members: members.map((member) => ({
                        robloxId: member.userId.toString(),
                        username: member.username,
                        displayName: member.displayName,
                        avatar: avatars.get(member.userId.toString()) ?? null
                    }))
                }
            })
        )

        return rosters
    }

    // ------------------------------------------------------- sign-up sheets

    static async getSignup(rankId: string, session: session): Promise<RankModel.signupOrNull> {
        const rank = await Rank.getRank(rankId, session)
        return presentSignup(rank.id)
    }

    /**
     * Creates or updates a rank's sign-up sheet.
     *
     * Upsert rather than separate create and update routes: a rank either has
     * a sheet or does not, and the dashboard edits one form either way.
     */
    static async putSignup(
        rankId: string,
        body: RankModel.signupBody,
        session: session
    ): Promise<RankModel.signupResponse> {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertPermission(session, rank.groupId, PERMISSION.MANAGE)

        const { slots, translations, ...patch } = body

        const [existing] = await db.select().from(rankSignups).where(eq(rankSignups.rankId, rankId)).limit(1)

        const sheet =
            existing ??
            (
                await db
                    .insert(rankSignups)
                    .values({
                        rankId,
                        name: patch.name ?? rank.cachedName,
                        color: patch.color ?? rank.color,
                        ...translationUpdate('SHEET', null, translations)
                    })
                    .returning()
            )[0]

        if (!sheet) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        if (existing && (Object.keys(patch).length > 0 || translations !== undefined)) {
            await db
                .update(rankSignups)
                .set({ ...patch, ...translationUpdate('SHEET', sheet.translations, translations) })
                .where(eq(rankSignups.id, sheet.id))
        }

        if (slots) await replaceSignupSlots(sheet.id, slots)

        await recordAudit(
            rank.groupId,
            session.user?.userId ?? null,
            'rank.signup',
            `Updated the ${rank.cachedName} sign-up sheet`
        )

        const result = await presentSignup(rankId)
        if (!result) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        return result
    }

    static async deleteSignup(rankId: string, session: session) {
        const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
        if (!rank) throw status(404, 'rank does not exist' satisfies RankModel.rankInvalid)

        await assertPermission(session, rank.groupId, PERMISSION.MANAGE)

        await db.delete(rankSignups).where(eq(rankSignups.rankId, rankId))

        await recordAudit(
            rank.groupId,
            session.user?.userId ?? null,
            'rank.signup',
            `Removed the ${rank.cachedName} sign-up sheet`
        )

        return 'Success' as globalModel.genericSuccess
    }

    /** Roblox roles in the group that are not bound on TrPTools yet. */
    static async getUnassignedRanks(groupId: string, session: session): Promise<RankModel.availableRanksResponse> {
        await assertPermission(session, groupId, PERMISSION.MANAGE)

        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        const credentials = await resolveCredentials(group.id, session.user?.userId)
        const [roles, bound] = await Promise.all([
            Roblox.getRoles(group.robloxId, credentials),
            db.select({ robloxId: rankRelations.robloxId }).from(rankRelations).where(eq(rankRelations.groupId, group.id))
        ])

        const taken = new Set(bound.map((row) => row.robloxId))

        return roles
            .filter((role) => !taken.has(role.id))
            .sort((a, b) => b.rank - a.rank)
            .map((role) => ({ robloxId: role.id, name: role.name, rank: role.rank }))
    }
}
