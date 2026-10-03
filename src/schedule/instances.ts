import { status } from 'elysia'
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import db from '../db'
import { events, shiftOccurrences, shiftVotes, shiftDrivers, users, shiftStaffLog, type Event } from '../db/schema'
import { findGroup, recordAudit } from '../groups/service'
import { assertGroupPermission, GetMembership } from '../utils/groupPermission'
import { has, PERM } from '../utils/permissions'
import { NON_MEMBER, isGroupMember } from '../utils/membershipRule'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { occurrencesBetween } from '../utils/recurrence'
import { presentTranslations, translationUpdate } from '../utils/translations'
import { mediaForOwners } from '../media/service'
import { loadSheets, loadSignups, presentSheets, sheetsVisibleTo, signupsOpen, viewerFor } from './sheets'
import { canEditSignups } from './eligibility'
import { actorForUser, actorForDiscord, type SignupActor } from './identity'
import { voteWindow, votingAllowed } from './onDemand'
import { publishSignupChange } from './events'
import type { ScheduleModel } from './model'

export type Instance = typeof shiftOccurrences.$inferSelect

function instanceValues(event: Event, start: Date) {
    const { eventId, groupId, name, slug, color, description, postDescription, translations, visibility, publicStaff, publicDrivers, onDemand, minimumVotes, minimumRank, voteRequireDiscord, websiteVoting, showVoters } = event
    return { eventId, groupId, name, slug, color, description, postDescription, translations, visibility, publicStaff, publicDrivers, onDemand, minimumVotes, minimumRank, voteRequireDiscord, websiteVoting, showVoters,
        start, end: new Date(start.getTime() + event.duration * 60_000), ...voteWindow(start, event.voteLeadMinutes, event.decisionLeadMinutes), decision: onDemand ? 'PENDING' : 'SCHEDULED'
    }
}

export async function ensureInstance(event: Event, start: Date) {
    const [existing] = await db.select().from(shiftOccurrences).where(and(eq(shiftOccurrences.eventId, event.eventId), eq(shiftOccurrences.start, start))).limit(1)
    if (existing) return existing
    if (event.archived || !occurrencesBetween(event.rrule, event.startTime, event.duration, start, start, 1).length) throw status(400, 'Bad Request')
    const [created] = await db.insert(shiftOccurrences).values(instanceValues(event, start)).onConflictDoNothing().returning()
    if (created) return created
    return (await db.select().from(shiftOccurrences).where(and(eq(shiftOccurrences.eventId, event.eventId), eq(shiftOccurrences.start, start))).limit(1))[0]!
}

export async function decideInstance(row: Instance, now = new Date()): Promise<Instance> {
    if (!row.onDemand || row.decision !== 'PENDING' || now < row.decisionAt) return row
    // The database function locks the occurrence before taking a fresh vote
    // snapshot. A cutoff racing a vote can never acknowledge an uncounted vote.
    await db.execute(sql`SELECT decide_shift(${row.id}::uuid, ${now.toISOString()}::timestamptz)`)
    const decided = (await db.select().from(shiftOccurrences).where(eq(shiftOccurrences.id, row.id)))[0]!
    if (decided.decision !== row.decision) await publishSignupChange(row.groupId, row.eventId, row.start, 'public-votes')
    return decided
}

export async function materializeInstances(entries: Array<{ event: Event; start: Date }>) {
    if (!entries.length) return new Map<string, Instance>()
    await db.insert(shiftOccurrences).values(entries.map(entry => instanceValues(entry.event, entry.start))).onConflictDoNothing()
    const starts = entries.map(entry => entry.start.getTime())
    const rows = await db.select().from(shiftOccurrences).where(and(
        inArray(shiftOccurrences.eventId, [...new Set(entries.map(entry => entry.event.eventId))]),
        gte(shiftOccurrences.start, new Date(Math.min(...starts))), lte(shiftOccurrences.start, new Date(Math.max(...starts)))
    ))
    const decided = await decideInstances(rows)
    return new Map(decided.map(row => [`${row.eventId}:${row.start.getTime()}`, row]))
}

async function decideInstances(rows: Instance[], now = new Date()) {
    const pending = rows.filter(row => row.onDemand && row.decision === 'PENDING' && row.decisionAt <= now)
    if (!pending.length) return rows
    await db.execute(sql`SELECT decide_shift(id, ${now.toISOString()}::timestamptz) FROM shift_occurrences WHERE ${inArray(shiftOccurrences.id, pending.map(row => row.id))}`)
    const refreshed = await db.select().from(shiftOccurrences).where(inArray(shiftOccurrences.id, rows.map(row => row.id)))
    const byId = new Map(refreshed.map(row => [row.id, row]))
    return rows.map(row => byId.get(row.id)!)
}

export async function preparationAllowed(event: Event, start: Date, now = new Date()) {
    if (event.archived) return false
    const row = await decideInstance(await ensureInstance(event, start), now)
    return row.decision === 'SCHEDULED' || row.decision === 'CONFIRMED'
}

async function readable(id: string, session: session) {
    const [raw] = await db.select().from(shiftOccurrences).where(eq(shiftOccurrences.id, id)).limit(1)
    if (!raw) throw status(404, 'Not Found')
    const group = await findGroup(raw.groupId)
    if (!group) throw status(404, 'Not Found')
    const membership = session.user ? await GetMembership(session.user.userId, group.id) : NON_MEMBER
    const manager = isSiteAdmin(session) || has(membership.permissions, PERM.MANAGE_SHIFTS)
    if (group.moderation === 'HIDDEN' && !manager) throw status(404, 'Not Found')
    const member = isGroupMember(membership) || manager
    if (!manager && ((!member && (group.visibility === 'PRIVATE' || !group.showShifts)) || raw.visibility !== 'PUBLIC' && !member)) throw status(404, 'Not Found')
    return { row: await decideInstance(raw), group, membership, manager, member }
}

export abstract class Instances {
    static async resolve(groupId: string, slug: string, occurrence: Date, session: session) {
        const group = await findGroup(groupId)
        if (!group || Number.isNaN(occurrence.getTime())) throw status(404, 'Not Found')
        const [stored] = await db.select({ row: shiftOccurrences }).from(shiftOccurrences).innerJoin(events, eq(shiftOccurrences.eventId, events.eventId))
            .where(and(eq(shiftOccurrences.groupId, group.id), eq(shiftOccurrences.start, occurrence), or(eq(shiftOccurrences.slug, slug), eq(events.slug, slug)))).limit(1)
        if (stored) return Instances.get(stored.row.id, session)
        const [event] = await db.select().from(events).where(and(eq(events.groupId, group.id), eq(events.slug, slug), eq(events.archived, false))).limit(1)
        if (!event) throw status(404, 'Not Found')
        // Check visibility before materializing an occurrence supplied by a caller.
        const membership = session.user ? await GetMembership(session.user.userId, group.id) : NON_MEMBER
        const member = isGroupMember(membership) || isSiteAdmin(session)
        if (!member && (event.visibility !== 'PUBLIC' || group.visibility === 'PRIVATE' || !group.showShifts || group.moderation === 'HIDDEN')) throw status(404, 'Not Found')
        if (Math.abs(occurrence.getTime() - Date.now()) > 120 * 86400000) throw status(404, 'Not Found')
        const row = await ensureInstance(event, occurrence)
        return Instances.get(row.id, session)
    }

    static async list(query: ScheduleModel.instanceQuery, session: session) {
        const group = await findGroup(query.groupId)
        if (!group) throw status(404, 'Not Found')
        await assertGroupPermission(session, group.id, PERM.MANAGE_SHIFTS)
        const now = new Date()
        const past = query.past === 'true'
        const before = query.before ? new Date(query.before) : now
        if (Number.isNaN(before.getTime())) throw status(400, 'Bad Request')
        const from = past ? new Date(before.getTime() - 120 * 86400000) : new Date(now.getTime() - 86400000)
        const to = past ? before : new Date(now.getTime() + 120 * 86400000)
        const rules = await db.select().from(events).where(and(eq(events.groupId, group.id), eq(events.archived, false)))
        const seeds = rules.flatMap(event => occurrencesBetween(event.rrule, event.startTime, event.duration, from, to, 200).map(o => ({ event, start: o.start })))
        // Bounded batches keep both Postgres and the edge's subrequest budget predictable.
        seeds.sort((a, b) => past ? b.start.getTime() - a.start.getTime() : a.start.getTime() - b.start.getTime())
        const bounded = seeds.slice(0, 200)
        if (bounded.length) await db.insert(shiftOccurrences).values(bounded.map(s => instanceValues(s.event, s.start))).onConflictDoNothing()
        const rows = await db.select().from(shiftOccurrences).where(and(eq(shiftOccurrences.groupId, group.id), past ? and(lt(shiftOccurrences.end, now), lt(shiftOccurrences.start, before)) : gte(shiftOccurrences.end, now)))
            .orderBy(past ? desc(shiftOccurrences.start) : asc(shiftOccurrences.start)).limit(100)
        return decideInstances(rows, now)
    }

    static async get(id: string, session: session): Promise<ScheduleModel.instanceResponse> {
        const { row, group, membership, manager, member } = await readable(id, session)
        const now = new Date()
        const past = row.end <= now
        const viewer = viewerFor(membership, session)
        const sheets = member ? sheetsVisibleTo(await loadSheets(group.id), membership, session) : []
        const signups = await loadSignups(sheets.flatMap(s => s.slots.map(slot => slot.id)), [row.eventId], row.start, row.start)
        const open = signupsOpen(row.start, row.end, group.signupLeadMinutes) && ['SCHEDULED', 'CONFIRMED'].includes(row.decision)
        const actor = session.user ? await actorForUser(session.user.userId) : { userId: null, discordUserId: null }
        const votes = await db.select().from(shiftVotes).where(eq(shiftVotes.occurrenceId, row.id))
        const mine = votes.find(v => v.userId && v.userId === actor.userId || v.discordUserId && v.discordUserId === actor.discordUserId)
        const drivers = manager || past && row.publicDrivers ? await db.select({ robloxId: shiftDrivers.robloxId, name: shiftDrivers.name }).from(shiftDrivers).where(eq(shiftDrivers.occurrenceId, row.id)) : []
        const staff = manager || past && row.publicStaff ? await db.select({ name: shiftStaffLog.name, slot: shiftStaffLog.slot, status: shiftStaffLog.status }).from(shiftStaffLog)
            .where(and(eq(shiftStaffLog.eventId, row.eventId), eq(shiftStaffLog.occurrence, row.start))).orderBy(asc(shiftStaffLog.updatedAt)) : []
        return { ...row, postDescription: past || manager ? row.postDescription : '', translations: presentTranslations('SHIFT', past || manager ? row.translations : { ...row.translations, postDescription: {} }),
            canManage: manager, images: (await mediaForOwners('SHIFT', [row.id], manager)).get(row.id) ?? [], drivers,
            staff,
            voteCount: votes.filter(v => v.attending).length, voted: Boolean(mine?.attending), canVote: Boolean(session.user) && votingAllowed(row, membership.robloxRank, Boolean(actor.discordUserId), true),
            voters: row.showVoters || manager ? votes.filter(v => v.attending).map(v => ({ name: v.name })) : [],
            withdrawnVoters: row.showVoters || manager ? votes.filter(v => !v.attending).map(v => ({ name: v.name })) : [],
            signupsOpen: open, signupsOpenAt: new Date(row.start.getTime() - group.signupLeadMinutes * 60_000), sheetsAvailable: sheets.length > 0,
            canEditSignups: !past && canEditSignups(viewer), discordRequired: group.requireDiscordForSignups,
            sheets: open ? presentSheets(sheets, row.eventId, row.start, signups, viewer) : [] }
    }

    static async update(id: string, body: ScheduleModel.instancePatch, session: session) {
        const { row } = await readable(id, session)
        await assertGroupPermission(session, row.groupId, PERM.MANAGE_SHIFTS)
        const { translations, ...fields } = body
        await db.update(shiftOccurrences).set({ ...fields, ...translationUpdate('SHIFT', row.translations, translations) }).where(eq(shiftOccurrences.id, id))
        await recordAudit(row.groupId, session.user?.userId ?? null, 'shift.occurrence.update', `Updated ${row.name} on ${row.start.toISOString()}`)
        await publishSignupChange(row.groupId, row.eventId, row.start, 'public-votes')
        return 'Success' as const
    }

    static async vote(id: string, attending: boolean, session: session) {
        if (!session.user) throw status(401, 'Unauthorized')
        const { row, membership } = await readable(id, session)
        const actor = await actorForUser(session.user.userId)
        return recordVote(row, actor, session.user.profile?.cachedDisplayName ?? session.user.profile?.cachedUsername ?? 'Unknown', membership.robloxRank, attending, true)
    }

    static async discordVote(guildId: string, eventId: string, occurrence: Date, discordId: string, name: string, attending: boolean) {
        const { botConfigs } = await import('../db/schema')
        const [event] = await db.select({ event: events }).from(events).innerJoin(botConfigs, eq(events.groupId, botConfigs.groupId))
            .where(and(eq(events.eventId, eventId), eq(botConfigs.guildId, guildId))).limit(1)
        if (!event) throw status(404, 'Not Found')
        const row = await decideInstance(await ensureInstance(event.event, occurrence))
        const actor = await actorForDiscord(discordId)
        const membership = actor.userId ? await GetMembership(actor.userId, row.groupId) : NON_MEMBER
        return recordVote(row, actor, name, membership.robloxRank, attending, false)
    }
}

async function recordVote(row: Instance, actor: SignupActor, name: string, rank: number, attending: boolean, website: boolean) {
    if (attending && !votingAllowed(row, rank, Boolean(actor.discordUserId), website)) throw status(403, 'Voting is closed or you do not meet this shift’s requirements')
    if (!row.onDemand || row.decision !== 'PENDING' || new Date() >= row.decisionAt) throw status(409, 'Voting is closed')
    const identity = actor.discordUserId ? `discord:${actor.discordUserId}` : `user:${actor.userId}`
    const result = await db.execute<{ recorded: boolean }>(sql`SELECT record_shift_vote(${row.id}::uuid, ${identity}, ${actor.userId}::uuid, ${actor.discordUserId}, ${name.slice(0, 100)}, ${attending}) AS recorded`)
    const { databaseRows } = await import('../db/rows')
    if (!databaseRows(result)[0]?.recorded) throw status(409, 'Voting is closed')
    await publishSignupChange(row.groupId, row.eventId, row.start, 'public-votes')
    return 'Success' as const
}

export async function recordDrivers(eventId: string, occurrence: Date, people: Array<{ robloxId: string; name: string }>) {
    if (!people.length) return
    const [event] = await db.select().from(events).where(eq(events.eventId, eventId)).limit(1)
    if (!event) return
    const row = await ensureInstance(event, occurrence)
    const known = await db.select({ id: users.robloxId, name: users.cachedUsername }).from(users).where(inArray(users.robloxId, people.map(p => Number(p.robloxId))))
    const names = new Map(known.map(p => [String(p.id), p.name]))
    const uniquePeople = [...new Map(people.filter(p => p.robloxId !== '0').map(p => [p.robloxId, p])).values()]
    if (uniquePeople.length) await db.insert(shiftDrivers).values(uniquePeople.map(p => ({ ...p, name: names.get(p.robloxId) ?? p.name, occurrenceId: row.id }))).onConflictDoNothing()
}

/** Preserve occurrence edits and commitments while applying new schedule defaults. */
export async function updateInstanceDefaults(previous: Event, next: Event, changed: string[]) {
    const future = and(eq(shiftOccurrences.eventId, previous.eventId), gt(shiftOccurrences.start, new Date()))
    const fields: Parameters<ReturnType<typeof db.update<typeof shiftOccurrences>>['set']>[0] = {}
    if (changed.includes('name')) { fields.name = next.name; fields.slug = next.slug }
    if (changed.includes('color')) fields.color = next.color
    if (changed.includes('duration')) fields.end = sql`${shiftOccurrences.start} + ${next.duration} * interval '1 minute'`
    if (changed.includes('visibility')) await db.update(shiftOccurrences).set({ visibility: next.visibility }).where(and(future, eq(shiftOccurrences.visibility, previous.visibility)))
    for (const field of ['publicStaff', 'publicDrivers', 'showVoters'] as const) {
        if (changed.includes(field)) await db.update(shiftOccurrences).set({ [field]: next[field] }).where(and(future, eq(shiftOccurrences[field], previous[field])))
    }
    if (Object.keys(fields).length) await db.update(shiftOccurrences).set(fields).where(future)
    if (changed.includes('description')) await db.update(shiftOccurrences).set({ description: next.description }).where(and(future, eq(shiftOccurrences.description, previous.description)))
    if (changed.includes('postDescription')) await db.update(shiftOccurrences).set({ postDescription: next.postDescription }).where(and(future, eq(shiftOccurrences.postDescription, previous.postDescription)))
    if (changed.includes('translations')) await db.update(shiftOccurrences).set({ translations: next.translations }).where(and(future, sql`${shiftOccurrences.translations} = ${JSON.stringify(previous.translations)}::jsonb`))
    if (changed.some(key => ['onDemand', 'minimumVotes', 'voteLeadMinutes', 'decisionLeadMinutes', 'minimumRank', 'voteRequireDiscord', 'websiteVoting'].includes(key))) {
        await db.update(shiftOccurrences).set({ onDemand: next.onDemand, minimumVotes: next.minimumVotes, minimumRank: next.minimumRank,
            voteRequireDiscord: next.voteRequireDiscord, websiteVoting: next.websiteVoting,
            voteOpensAt: sql`${shiftOccurrences.start} - ${next.voteLeadMinutes} * interval '1 minute'`,
            decisionAt: sql`${shiftOccurrences.start} - ${next.decisionLeadMinutes} * interval '1 minute'`,
            decision: next.onDemand ? 'PENDING' : 'SCHEDULED'
        }).where(and(future, inArray(shiftOccurrences.decision, ['SCHEDULED', 'PENDING']), sql`NOT EXISTS (SELECT 1 FROM shift_votes WHERE occurrence_id = ${shiftOccurrences.id})`, sql`NOT EXISTS (SELECT 1 FROM shift_signups WHERE event_id = ${shiftOccurrences.eventId} AND occurrence = ${shiftOccurrences.start})`))
    }
    if (changed.includes('rrule') || changed.includes('startTime')) {
        const held = await db.select().from(shiftOccurrences).where(future)
        const removed = held.filter(row => row.decision !== 'FAILED' && !occurrencesBetween(next.rrule, next.startTime, next.duration, row.start, row.start, 1).length)
        if (removed.length) await db.update(shiftOccurrences).set({ decision: 'CANCELED' }).where(inArray(shiftOccurrences.id, removed.map(row => row.id)))
    }
}
