import { status } from 'elysia'
import { and, asc, eq, gte, inArray, lt, notInArray, or } from 'drizzle-orm'
import db from '../db'
import {
    claimableConnections, rankRelations, rankSlotPoints, shiftAttendance, shiftOccurrences, shiftSignups,
    signupSheets, signupSlots, users
} from '../db/schema'
import { findGroup, recordAudit } from '../groups/service'
import { loadSheets } from '../schedule/sheets'
import { requireUser } from '../utils/authPlugin'
import { assertAnyGroupPermission, assertGroupPermission, hasGroupPermission, invalidateUserPermissions } from '../utils/groupPermission'
import { PERM } from '../utils/permissions'
import { Roblox } from '../utils/roblox'
import { groupCredentials, userCredentials } from '../utils/robloxCredentials'
import { dataRedis, deleteByPattern } from '../utils/redis'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { cloudFor } from '../claimables/service'
import { highestRank, membershipRoles } from '../claimables/roblox'
import { AttendanceModel } from './model'
import { monthOf, monthRange, totalPoints, verdictFor, type Activity, type RankRules, type ShiftWindow } from './points'

type RankRow = typeof rankRelations.$inferSelect

async function groupFor(id: string) {
    const group = await findGroup(id)
    if (!group) throw status(404, 'Not Found')
    return group
}

async function rankFor(rankId: string) {
    const [rank] = await db.select().from(rankRelations).where(eq(rankRelations.id, rankId)).limit(1)
    if (!rank) throw status(404, 'Not Found')
    return rank
}

function rulesOf(rank: RankRow, slotPoints: Map<string, number>): RankRules {
    return {
        id: rank.id,
        minPoints: rank.attendanceMinPoints,
        maxPoints: rank.attendanceMaxPoints,
        requiredPercent: rank.attendanceRequiredPercent,
        unsignedPoints: rank.attendanceUnsignedPoints,
        promotionRankId: rank.promotionRankId,
        demotionRankId: rank.demotionRankId,
        slotPoints
    }
}

/** Runs `work` over `items` a few at a time, so a big roster cannot stampede Roblox. */
async function pooled<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const index = next++
            results[index] = await work(items[index]!)
        }
    }))
    return results
}

/** Everybody's activity in the month, keyed by Roblox id, then by occurrence. */
async function monthActivity(groupId: string, from: Date, to: Date) {
    const shifts = await db.select({ id: shiftOccurrences.id, eventId: shiftOccurrences.eventId, start: shiftOccurrences.start, end: shiftOccurrences.end })
        .from(shiftOccurrences)
        .where(and(
            eq(shiftOccurrences.groupId, groupId),
            gte(shiftOccurrences.start, from),
            lt(shiftOccurrences.start, new Date(Math.min(to.getTime(), Date.now()))),
            notInArray(shiftOccurrences.decision, ['CANCELED', 'FAILED', 'PENDING'])
        ))
    const activity = new Map<string, Map<string, Activity>>()
    const names = new Map<string, string>()
    if (!shifts.length) return { shifts: [] as ShiftWindow[], activity, names }

    const attended = await db.select().from(shiftAttendance).where(inArray(shiftAttendance.occurrenceId, shifts.map((shift) => shift.id)))
    const tracked = new Set(attended.map((row) => row.occurrenceId))
    const touch = (robloxId: string, occurrenceId: string) => {
        const person = activity.get(robloxId) ?? new Map<string, Activity>()
        activity.set(robloxId, person)
        const entry = person.get(occurrenceId) ?? {}
        person.set(occurrenceId, entry)
        return entry
    }
    for (const row of attended) {
        touch(row.robloxId, row.occurrenceId).seconds = row.seconds
        names.set(row.robloxId, row.name)
    }

    // Sign-ups are keyed by shift and start, not by occurrence row.
    const byStart = new Map(shifts.map((shift) => [`${shift.eventId}:${shift.start.getTime()}`, shift.id]))
    const signups = await db.select({
        eventId: shiftSignups.eventId, occurrence: shiftSignups.occurrence, slotId: shiftSignups.slotId,
        userId: shiftSignups.userId, discordUserId: shiftSignups.discordUserId
    }).from(shiftSignups).where(and(
        inArray(shiftSignups.eventId, [...new Set(shifts.map((shift) => shift.eventId))]),
        gte(shiftSignups.occurrence, from), lt(shiftSignups.occurrence, to)
    ))
    const userIds = signups.flatMap((row) => row.userId ? [row.userId] : [])
    const discordIds = signups.flatMap((row) => !row.userId && row.discordUserId ? [row.discordUserId] : [])
    // A Discord-only sign-up counts once its Discord account is linked to a
    // TrPTools one, which is the only way to know whose Roblox account it is.
    const people = userIds.length || discordIds.length
        ? await db.select({ id: users.id, robloxId: users.robloxId, discordId: users.discordId, name: users.cachedUsername })
            .from(users).where(or(
                userIds.length ? inArray(users.id, userIds) : undefined,
                discordIds.length ? inArray(users.discordId, discordIds) : undefined
            ))
        : []
    for (const row of signups) {
        const occurrenceId = byStart.get(`${row.eventId}:${row.occurrence.getTime()}`)
        const person = people.find((user) => row.userId ? user.id === row.userId : user.discordId === row.discordUserId)
        if (!occurrenceId || !person) continue
        const robloxId = String(person.robloxId)
        touch(robloxId, occurrenceId).slotId = row.slotId
        if (person.name && !names.has(robloxId)) names.set(robloxId, person.name)
    }

    return {
        shifts: shifts.map((shift) => ({ id: shift.id, start: shift.start.getTime(), end: shift.end.getTime(), tracked: tracked.has(shift.id) })),
        activity,
        names
    }
}

/**
 * Every standing for one group and month.
 *
 * Who is evaluated: anybody who attended or signed up this month, plus the
 * holders of any rank with a minimum — somebody who never turned up is
 * exactly who a minimum is for, and has no activity to be found by.
 * Permission is never read from here: a standing is worked out against the
 * Roblox rank the person holds right now, like everything else (§5).
 */
async function computeStandings(groupId: string, month: string, only?: string) {
    const group = await groupFor(groupId)
    const range = monthRange(month)
    if (!range) throw status(400, 'Bad Request')
    const ranks = await db.select().from(rankRelations).where(eq(rankRelations.groupId, group.id)).orderBy(asc(rankRelations.cachedRank))
    const byRole = new Map(ranks.map((rank) => [rank.robloxId, rank]))
    const byId = new Map(ranks.map((rank) => [rank.id, rank]))
    const pointRows = ranks.length
        ? await db.select().from(rankSlotPoints).where(inArray(rankSlotPoints.rankId, ranks.map((rank) => rank.id)))
        : []
    const rules = new Map(ranks.map((rank) => [rank.id, rulesOf(rank, new Map(
        pointRows.filter((row) => row.rankId === rank.id).map((row) => [row.slotId, row.points])
    ))]))
    const { shifts, activity, names } = await monthActivity(group.id, range.from, range.to)

    const known = new Map<string, RankRow>()
    let incomplete = false
    for (const rank of ranks) {
        if (rank.attendanceMinPoints === null || !rank.demotionRankId || only) continue
        const roster = await Roblox.getRoleMembers(group.robloxId, rank.robloxId, 100).catch(() => null)
        if (!roster) { incomplete = true; continue }
        for (const member of roster.members) {
            known.set(String(member.userId), rank)
            if (!names.has(String(member.userId))) names.set(String(member.userId), member.username)
        }
    }

    const candidates = only ? [only] : [...new Set([...activity.keys(), ...known.keys()])].slice(0, 300)
    const credentials = await groupCredentials(group.id)
    const resolved = await pooled(candidates, 8, async (robloxId) => {
        if (known.has(robloxId)) return [robloxId, known.get(robloxId)!] as const
        const lookup = await Roblox.lookupMembership(robloxId, group.robloxId, credentials).catch(() => ({ status: 'UNKNOWN' as const }))
        if (lookup.status === 'UNKNOWN') incomplete = true
        return [robloxId, lookup.status === 'MEMBER' ? byRole.get(String(lookup.membership.role.id)) ?? null : null] as const
    })

    const people = resolved.flatMap(([robloxId, rank]) => {
        if (!rank || rank.cachedRank >= 255) return []
        const own = rules.get(rank.id)!
        const { points, counted } = totalPoints(own, shifts, activity.get(robloxId) ?? new Map())
        const verdict = verdictFor(own, points)
        const target = verdict === 'PROMOTE' ? byId.get(own.promotionRankId!) : verdict === 'DEMOTE' ? byId.get(own.demotionRankId!) : undefined
        return [{
            robloxId, name: names.get(robloxId) ?? robloxId, avatar: null as string | null,
            rankId: rank.id, rankName: rank.cachedName, rankColor: rank.color,
            points, shifts: counted, minPoints: own.minPoints, maxPoints: own.maxPoints,
            verdict: target ? verdict : null, targetRankId: target?.id ?? null, targetRankName: target?.cachedName ?? null
        }]
    })

    const missing = people.filter((person) => person.name === person.robloxId).map((person) => person.robloxId)
    if (missing.length) {
        const found = await Roblox.getUsers(missing).catch(() => new Map())
        for (const person of people) person.name = found.get(person.robloxId)?.name ?? person.name
    }
    const avatars = await Roblox.getAvatars(people.map((person) => person.robloxId)).catch(() => new Map<string, string>())
    for (const person of people) person.avatar = avatars.get(person.robloxId) ?? null

    const order = { PROMOTE: 0, DEMOTE: 1 } as Record<string, number>
    people.sort((a, b) => (order[a.verdict ?? ''] ?? 2) - (order[b.verdict ?? ''] ?? 2) || b.points - a.points || a.name.localeCompare(b.name))
    const configuredRanks = ranks.filter((rank) =>
        (rank.attendanceMaxPoints !== null && rank.promotionRankId) || (rank.attendanceMinPoints !== null && rank.demotionRankId)).length
    return { group, ranks: byId, people, incomplete, configuredRanks }
}

async function connectionFor(groupId: string, userId: string) {
    const { accessToken } = await userCredentials(userId, true)
    const [profile] = await db.select({ scopes: users.robloxWriteScopes }).from(users).where(eq(users.id, userId)).limit(1)
    const [connection] = await db.select().from(claimableConnections).where(eq(claimableConnections.groupId, groupId)).limit(1)
    let connected = false
    try { await cloudFor(groupId); connected = true } catch { /* the page offers to connect */ }
    return {
        hasWriteScope: Boolean(accessToken && profile?.scopes.split(' ').includes('group:write')),
        connected,
        authorizedByMe: connection?.authorizedBy === userId
    }
}

export abstract class Attendance {
    static async settings(rankId: string, session: session): Promise<AttendanceModel.Settings> {
        const rank = await rankFor(rankId)
        await assertGroupPermission(session, rank.groupId, PERM.MANAGE_ATTENDANCE)
        const [sheets, points, others] = await Promise.all([
            loadSheets(rank.groupId),
            db.select().from(rankSlotPoints).where(eq(rankSlotPoints.rankId, rank.id)),
            db.select({ id: rankRelations.id, name: rankRelations.cachedName, rank: rankRelations.cachedRank })
                .from(rankRelations).where(eq(rankRelations.groupId, rank.groupId)).orderBy(asc(rankRelations.cachedRank))
        ])
        const worth = new Map(points.map((row) => [row.slotId, row.points]))
        return {
            rankId: rank.id,
            minPoints: rank.attendanceMinPoints,
            maxPoints: rank.attendanceMaxPoints,
            requiredPercent: rank.attendanceRequiredPercent,
            unsignedPoints: rank.attendanceUnsignedPoints,
            promotionRankId: rank.promotionRankId,
            demotionRankId: rank.demotionRankId,
            // Only what this rank could actually sign up for; an empty list on
            // a slot means every member, as everywhere else (§6.1).
            slots: sheets.flatMap((sheet) => sheet.slots
                .filter((slot) => slot.rankIds.length === 0 || slot.rankIds.includes(rank.id))
                .map((slot) => ({
                    slotId: slot.id, name: slot.name, sheetId: sheet.sheetId, sheetName: sheet.name, sheetColor: sheet.color,
                    points: worth.get(slot.id) ?? 1
                }))),
            ranks: others.filter((other) => other.id !== rank.id && other.rank < 255)
        }
    }

    static async saveSettings(rankId: string, body: AttendanceModel.SettingsBody, session: session) {
        const rank = await rankFor(rankId)
        await assertGroupPermission(session, rank.groupId, PERM.MANAGE_ATTENDANCE)
        const paths = [body.promotionRankId, body.demotionRankId].filter((id): id is string => Boolean(id))
        if (paths.includes(rank.id)) throw status(400, 'Bad Request')
        if (paths.length) {
            const found = await db.select({ id: rankRelations.id, rank: rankRelations.cachedRank }).from(rankRelations)
                .where(and(eq(rankRelations.groupId, rank.groupId), inArray(rankRelations.id, paths)))
            if (found.length !== new Set(paths).size || found.some((row) => row.rank >= 255)) throw status(400, 'Bad Request')
        }
        // A slot from another group's sheet is not this rank's to price.
        const slotIds = [...new Set(body.slots.map((slot) => slot.slotId))]
        const owned = slotIds.length
            ? await db.select({ id: signupSlots.id }).from(signupSlots).innerJoin(signupSheets, eq(signupSlots.sheetId, signupSheets.id))
                .where(and(eq(signupSheets.groupId, rank.groupId), inArray(signupSlots.id, slotIds)))
            : []
        if (owned.length !== slotIds.length) throw status(400, 'Bad Request')

        await db.update(rankRelations).set({
            attendanceMinPoints: body.minPoints,
            attendanceMaxPoints: body.maxPoints,
            attendanceRequiredPercent: body.requiredPercent,
            attendanceUnsignedPoints: body.unsignedPoints,
            promotionRankId: body.promotionRankId,
            demotionRankId: body.demotionRankId
        }).where(eq(rankRelations.id, rank.id))
        for (const slot of body.slots) {
            await db.insert(rankSlotPoints).values({ rankId: rank.id, slotId: slot.slotId, points: slot.points })
                .onConflictDoUpdate({ target: [rankSlotPoints.rankId, rankSlotPoints.slotId], set: { points: slot.points } })
        }
        await recordAudit(rank.groupId, session.user?.userId ?? null, 'rank.attendance', `Updated attendance rules for ${rank.cachedName}`)
        return 'Success' as const
    }

    static async standings(groupId: string, month: string | undefined, session: session): Promise<AttendanceModel.Standings> {
        const group = await groupFor(groupId)
        await assertAnyGroupPermission(session, group.id, [PERM.MANAGE_ATTENDANCE, PERM.MANAGE_PROMOTIONS])
        const user = requireUser(session)
        const selected = month ?? monthOf(new Date())
        const [computed, canApply, connection] = await Promise.all([
            computeStandings(group.id, selected),
            hasGroupPermission(session, group.id, PERM.MANAGE_PROMOTIONS),
            connectionFor(group.id, user.userId)
        ])
        return {
            month: selected, configuredRanks: computed.configuredRanks, canApply: canApply && !session.viaApiKey,
            connection, people: computed.people, incomplete: computed.incomplete
        }
    }

    /**
     * Moves one person along the path their attendance earned.
     *
     * The standing is worked out again here rather than taken from the page:
     * a promotion is decided by the server's arithmetic, not by a button that
     * may have been drawn an hour ago. The Roblox side follows claimable
     * ranks exactly — the same connection, the same check that the person
     * who authorized it still outranks both ends, and the same assign-then-
     * unassign so a failure can never leave somebody with no role.
     */
    static async apply(groupId: string, body: AttendanceModel.ApplyBody, session: session) {
        const group = await groupFor(groupId)
        const user = requireUser(session)
        if (session.viaApiKey) throw status(403, 'Forbidden')
        await assertGroupPermission(session, group.id, PERM.MANAGE_PROMOTIONS)
        const { people, ranks } = await computeStandings(group.id, body.month, body.robloxId)
        const standing = people[0]
        if (!standing || standing.verdict !== body.verdict || !standing.targetRankId) {
            throw status(409, 'their standing has changed, refresh and try again' satisfies AttendanceModel.stale)
        }
        const target = ranks.get(standing.targetRankId)!
        const { cloud, writer } = await cloudFor(group.id)
        try {
            const roles = await cloud.roles(group.robloxId)
            const [membership, writerMembership, actorMembership] = await Promise.all([
                cloud.membership(group.robloxId, Number(body.robloxId)),
                cloud.membership(group.robloxId, writer.robloxId),
                isSiteAdmin(session) ? Promise.resolve(null) : cloud.membership(group.robloxId, user.robloxId)
            ])
            const role = roles.find((item) => item.id === target.robloxId)
            const current = highestRank(membership, roles)
            const writerRank = highestRank(writerMembership, roles)
            const actorRank = isSiteAdmin(session) ? 255 : highestRank(actorMembership, roles)
            if (!membership || !role || role.rank < 1 || role.rank >= 255) throw status(409, 'their standing has changed, refresh and try again' satisfies AttendanceModel.stale)
            if (role.rank >= actorRank || current >= actorRank) throw status(403, 'you can only move people between ranks below your own' satisfies AttendanceModel.unsafe)
            if (role.rank >= writerRank || current >= writerRank) throw status(503, 'The group needs to reconnect Roblox rank changes')
            const targetPath = `groups/${group.robloxId}/roles/${role.id}`
            const removed = membershipRoles(membership).filter((path) =>
                path !== targetPath && (roles.find((item) => path.endsWith(`/roles/${item.id}`))?.rank ?? 0) > 1)
            await cloud.change(membership, targetPath, removed)
            const after = await cloud.membership(group.robloxId, Number(body.robloxId)).catch(() => null)
            const confirmed = Boolean(after && membershipRoles(after).includes(targetPath))
            await invalidatePerson(group.id, group.robloxId, body.robloxId)
            await recordAudit(group.id, user.userId, body.verdict === 'PROMOTE' ? 'rank.promote' : 'rank.demote',
                `${body.verdict === 'PROMOTE' ? 'Promoted' : 'Demoted'} ${standing.name} from ${standing.rankName} to ${target.cachedName} on ${standing.points} attendance points for ${body.month}`)
            return { state: confirmed ? 'CONFIRMED' as const : 'PENDING' as const }
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error) throw error
            console.warn('[attendance] rank change failed', error instanceof Error ? error.message : 'unknown')
            await invalidatePerson(group.id, group.robloxId, body.robloxId)
            throw status(503, 'Roblox could not change that rank, try again shortly' satisfies AttendanceModel.unreachable)
        }
    }
}

/** Forgets what was cached about somebody's rank, so every page reads the new one. */
async function invalidatePerson(groupId: string, robloxGroupId: string, robloxId: string) {
    const [account] = await db.select({ id: users.id }).from(users).where(eq(users.robloxId, Number(robloxId))).limit(1)
    await Promise.all([
        account ? invalidateUserPermissions(account.id) : Promise.resolve(),
        account ? dataRedis.del(`perm:last:${groupId}:${account.id}`) : Promise.resolve(0),
        dataRedis.del(`roblox:membership:${robloxGroupId}:${robloxId}`, `roblox:usergroups:${robloxId}`),
        deleteByPattern(`roblox:rolemembers:${robloxGroupId}:*`)
    ])
}
