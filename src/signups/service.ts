import { status } from 'elysia'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import db from '../db'
import {
    rankRelations,
    signupSheetRanks,
    signupSheets,
    signupSlotRanks,
    signupSlots
} from '../db/schema'
import { globalModel } from '../utils/globalModel'
import { assertGroupPermission } from '../utils/groupPermission'
import { PERM } from '../utils/permissions'
import { presentTranslations, translationUpdate } from '../utils/translations'
import type { session } from '../utils/sessionVerifier'
import { findGroup, recordAudit } from '../groups/service'
import { GroupModel } from '../groups/model'
import { SignupModel } from './model'

/**
 * Keeps a rank list to ranks this group has actually bound.
 *
 * The ids arrive from a request, and a row pointing at another group's rank
 * would admit somebody the group has no relationship with. Filtering rather
 * than refusing: a rank unbound between the editor loading and saving is an
 * ordinary race, and failing the whole save over it would lose the rest of it.
 */
async function ownRanks(groupId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []

    const rows = await db
        .select({ id: rankRelations.id })
        .from(rankRelations)
        .where(and(eq(rankRelations.groupId, groupId), inArray(rankRelations.id, [...new Set(ids)])))

    return rows.map((row) => row.id)
}

/**
 * A rank list is replaced rather than merged.
 *
 * Two near-identical functions rather than one over both tables: a single
 * generic one needs the column and the table threaded through as values, which
 * costs the type checking that makes these safe at all — and the whole body is
 * two statements.
 */
async function setSheetRanks(sheetId: string, rankIds: string[]) {
    await db.delete(signupSheetRanks).where(eq(signupSheetRanks.sheetId, sheetId))
    if (rankIds.length > 0) {
        await db.insert(signupSheetRanks).values(rankIds.map((rankId) => ({ sheetId, rankId })))
    }
}

async function setSlotRanks(slotId: string, rankIds: string[]) {
    await db.delete(signupSlotRanks).where(eq(signupSlotRanks.slotId, slotId))
    if (rankIds.length > 0) {
        await db.insert(signupSlotRanks).values(rankIds.map((rankId) => ({ slotId, rankId })))
    }
}

/** One sheet with its slots and both rank lists. */
async function present(sheetId: string): Promise<SignupModel.sheetResponse | null> {
    const [sheet] = await db.select().from(signupSheets).where(eq(signupSheets.id, sheetId)).limit(1)
    if (!sheet) return null

    const slots = await db
        .select()
        .from(signupSlots)
        .where(eq(signupSlots.sheetId, sheet.id))
        .orderBy(asc(signupSlots.order))

    const sheetRanks = await db
        .select({ rankId: signupSheetRanks.rankId })
        .from(signupSheetRanks)
        .where(eq(signupSheetRanks.sheetId, sheet.id))

    const slotRanks =
        slots.length > 0
            ? await db
                  .select({ slotId: signupSlotRanks.slotId, rankId: signupSlotRanks.rankId })
                  .from(signupSlotRanks)
                  .where(
                      inArray(
                          signupSlotRanks.slotId,
                          slots.map((slot) => slot.id)
                      )
                  )
            : []

    return {
        id: sheet.id,
        groupId: sheet.groupId,
        enabled: sheet.enabled,
        name: sheet.name,
        description: sheet.description,
        translations: presentTranslations('SHEET', sheet.translations),
        color: sheet.color,
        uniformRanks: sheet.uniformRanks,
        order: sheet.order,
        rankIds: sheetRanks.map((rank) => rank.rankId),
        discordChannel: sheet.discordChannel,
        discordPingRole: sheet.discordPingRole,
        slots: slots.map((slot) => ({
            id: slot.id,
            name: slot.name,
            description: slot.description,
            translations: presentTranslations('SLOT', slot.translations),
            capacity: slot.capacity,
            order: slot.order,
            rankIds: slotRanks.filter((rank) => rank.slotId === slot.id).map((rank) => rank.rankId)
        }))
    }
}

/**
 * Replaces a sheet's slots wholesale, reusing rows whose name is unchanged.
 *
 * Reuse is what keeps existing sign-ups attached: dropping and recreating the
 * slots would cascade every signup on every future occurrence away because
 * somebody renamed the sheet's colour. It is the same rule the application
 * editor uses for its questions, and for the same reason.
 */
async function replaceSlots(sheetId: string, groupId: string, slots: SignupModel.slotInput[]) {
    const existing = await db.select().from(signupSlots).where(eq(signupSlots.sheetId, sheetId))
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

        let id = match?.id

        if (match) {
            keep.add(match.id)
            await db.update(signupSlots).set(values).where(eq(signupSlots.id, match.id))
        } else {
            const [created] = await db
                .insert(signupSlots)
                .values({ sheetId, ...values })
                .returning({ id: signupSlots.id })

            if (created) {
                keep.add(created.id)
                id = created.id
            }
        }

        if (id && slot.rankIds !== undefined) {
            await setSlotRanks(id, await ownRanks(groupId, slot.rankIds))
        }
    }

    const removed = existing.filter((slot) => !keep.has(slot.id))
    if (removed.length > 0) {
        await db.delete(signupSlots).where(
            inArray(
                signupSlots.id,
                removed.map((slot) => slot.id)
            )
        )
    }
}

export abstract class Signups {
    private static async requireSheet(sheetId: string, session: session) {
        const [sheet] = await db.select().from(signupSheets).where(eq(signupSheets.id, sheetId)).limit(1)
        if (!sheet) throw status(404, 'sign-up sheet does not exist' satisfies SignupModel.sheetInvalid)

        await assertGroupPermission(session, sheet.groupId, PERM.MANAGE_SIGNUPS)

        return sheet
    }

    static async list(groupIdOrSlug: string, session: session): Promise<SignupModel.sheetsResponse> {
        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertGroupPermission(session, group.id, PERM.MANAGE_SIGNUPS)

        const rows = await db
            .select({ id: signupSheets.id })
            .from(signupSheets)
            .where(eq(signupSheets.groupId, group.id))
            .orderBy(asc(signupSheets.order), asc(signupSheets.createdAt))

        const sheets = await Promise.all(rows.map((row) => present(row.id)))

        return sheets.filter((sheet): sheet is SignupModel.sheetResponse => sheet !== null)
    }

    static async get(sheetId: string, session: session): Promise<SignupModel.sheetResponse> {
        await Signups.requireSheet(sheetId, session)

        const sheet = await present(sheetId)
        if (!sheet) throw status(404, 'sign-up sheet does not exist' satisfies SignupModel.sheetInvalid)

        return sheet
    }

    /**
     * A new sheet, disabled and with no ranks on it.
     *
     * Disabled because an empty rank list means *everyone* (see the model): a
     * sheet that arrived switched on would be open to the whole group the
     * moment it was named, before anybody had said who it was for.
     */
    static async create(body: SignupModel.createBody, session: session): Promise<SignupModel.createResponse> {
        const group = await findGroup(body.groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertGroupPermission(session, group.id, PERM.MANAGE_SIGNUPS)

        const [last] = await db
            .select({ order: signupSheets.order })
            .from(signupSheets)
            .where(eq(signupSheets.groupId, group.id))
            .orderBy(desc(signupSheets.order))
            .limit(1)

        const [sheet] = await db
            .insert(signupSheets)
            .values({
                groupId: group.id,
                name: body.name,
                color: body.color ?? '#4287f5',
                order: (last?.order ?? -1) + 1
            })
            .returning({ id: signupSheets.id })

        if (!sheet) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        await recordAudit(group.id, session.user?.userId ?? null, 'signup.create', `Created sign-up sheet ${body.name}`)

        return { id: sheet.id }
    }

    static async update(sheetId: string, body: SignupModel.updateBody, session: session) {
        const sheet = await Signups.requireSheet(sheetId, session)

        const { translations, rankIds, ...patch } = body

        if (Object.keys(patch).length > 0 || translations !== undefined) {
            await db
                .update(signupSheets)
                .set({ ...patch, ...translationUpdate('SHEET', sheet.translations, translations) })
                .where(eq(signupSheets.id, sheet.id))
        }

        if (rankIds !== undefined) {
            await setSheetRanks(sheet.id, await ownRanks(sheet.groupId, rankIds))
        }

        await recordAudit(
            sheet.groupId,
            session.user?.userId ?? null,
            'signup.update',
            `Updated the ${sheet.name} sign-up sheet`
        )

        const result = await present(sheet.id)
        if (!result) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        return result
    }

    static async setSlots(sheetId: string, body: SignupModel.slotsBody, session: session) {
        const sheet = await Signups.requireSheet(sheetId, session)

        await replaceSlots(sheet.id, sheet.groupId, body.slots)

        await recordAudit(
            sheet.groupId,
            session.user?.userId ?? null,
            'signup.update',
            `Updated the slots on ${sheet.name}`
        )

        const result = await present(sheet.id)
        if (!result) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        return result
    }

    static async remove(sheetId: string, session: session) {
        const sheet = await Signups.requireSheet(sheetId, session)

        await db.delete(signupSheets).where(eq(signupSheets.id, sheet.id))

        await recordAudit(
            sheet.groupId,
            session.user?.userId ?? null,
            'signup.delete',
            `Deleted the ${sheet.name} sign-up sheet`
        )

        return 'Success' as globalModel.genericSuccess
    }

    /** The group's bound ranks, for the rank picker on a sheet. */
    static async pickableRanks(groupIdOrSlug: string, session: session): Promise<SignupModel.pickableRanksResponse> {
        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertGroupPermission(session, group.id, PERM.MANAGE_SIGNUPS)

        const rows = await db
            .select({
                id: rankRelations.id,
                name: rankRelations.cachedName,
                rank: rankRelations.cachedRank,
                color: rankRelations.color
            })
            .from(rankRelations)
            .where(eq(rankRelations.groupId, group.id))
            .orderBy(desc(rankRelations.cachedRank))

        return rows
    }
}
