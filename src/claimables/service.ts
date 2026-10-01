import { status } from 'elysia'
import { and, asc, eq } from 'drizzle-orm'
import db from '../db'
import { claimableConnections, claimableRanks, groups, rankRelations, users } from '../db/schema'
import { findGroup, recordAudit } from '../groups/service'
import { requireUser } from '../utils/authPlugin'
import { assertGroupPermission, invalidateUserPermissions } from '../utils/groupPermission'
import { has, PERM } from '../utils/permissions'
import { isBanned } from '../utils/moderation'
import { isSiteAdmin, type session } from '../utils/sessionVerifier'
import { userCredentials } from '../utils/robloxCredentials'
import { dataRedis, deleteByPattern } from '../utils/redis'
import { childSlug, uniqueWithin } from '../utils/slug'
import { robloxCreationDate } from '../utils/robloxProfile'
import { mergeTranslations, presentTranslations } from '../utils/translations'
import { rateLimit, RateLimitError } from '../utils/ratelimit'
import { ClaimableModel } from './model'
import { confirmedRoles, qualifications } from './eligibility'
import { highestRank, membershipRoles, RankCloud } from './roblox'

const selection = { claim: claimableRanks, rankName: rankRelations.cachedName, rankColor: rankRelations.color }
const pendingKey = (group: string, user: string) => `claimable:pending:${group}:${user}`
type Pending = { claimId: string; target: string; removed: string[]; robloxId: string; name: string }

async function groupFor(id: string) {
    const group = await findGroup(id)
    if (!group) throw status(404, 'Not Found')
    return group
}
async function load(id: string) {
    const [row] = await db.select(selection).from(claimableRanks)
        .leftJoin(rankRelations, eq(claimableRanks.rankId, rankRelations.id)).where(eq(claimableRanks.id, id)).limit(1)
    if (!row) throw status(404, 'This claimable rank is unavailable' satisfies ClaimableModel.invalid)
    return { ...row.claim, translations: presentTranslations('CLAIMABLE', row.claim.translations), rankName: row.rankName, rankColor: row.rankColor }
}
async function published(id: string) {
    const claim = await load(id)
    const group = await groupFor(claim.groupId)
    if (group.visibility === 'PRIVATE' || group.moderation === 'HIDDEN' || !claim.enabled || !claim.rankId) {
        throw status(404, 'This claimable rank is unavailable' satisfies ClaimableModel.invalid)
    }
    return { claim, group }
}
async function cloudFor(groupId: string) {
    const [connection] = await db.select().from(claimableConnections).where(eq(claimableConnections.groupId, groupId)).limit(1)
    if (!connection) throw status(503, 'The group needs to reconnect Roblox rank changes' satisfies ClaimableModel.unavailable)
    const [writer] = await db.select().from(users).where(eq(users.id, connection.authorizedBy)).limit(1)
    if (!writer || isBanned(writer)) throw status(503, 'The group needs to reconnect Roblox rank changes' satisfies ClaimableModel.unavailable)
    const { accessToken } = await userCredentials(writer.id, true)
    const [fresh] = await db.select({ scopes: users.robloxWriteScopes }).from(users).where(eq(users.id, writer.id)).limit(1)
    if (!accessToken || !fresh?.scopes.split(' ').includes('group:write')) {
        throw status(503, 'The group needs to reconnect Roblox rank changes' satisfies ClaimableModel.unavailable)
    }
    const request = async (input: string, init?: RequestInit) => {
        await rateLimit('claimable:writer', writer.id, 80, 60)
        return fetch(input, init)
    }
    return { cloud: new RankCloud(accessToken, request), writer }
}
async function checkEditor(groupId: string, rankId: string, maximum: number, session: session) {
    await assertGroupPermission(session, groupId, PERM.MANAGE_CLAIMABLES)
    const [rank] = await db.select().from(rankRelations).where(and(eq(rankRelations.id, rankId), eq(rankRelations.groupId, groupId))).limit(1)
    if (!rank || rank.cachedRank < 1 || rank.cachedRank >= 255) throw status(400, 'This claimable rank is unavailable')
    if (!isSiteAdmin(session)) {
        const group = await groupFor(groupId)
        const { accessToken } = await userCredentials(requireUser(session).userId)
        if (!accessToken) throw status(503, 'The group needs to reconnect Roblox rank changes')
        const cloud = new RankCloud(accessToken)
        const roles = await cloud.roles(group.robloxId)
        const membership = await cloud.membership(group.robloxId, requireUser(session).robloxId)
        const ownRank = highestRank(membership, roles)
        const target = roles.find(role => role.id === rank.robloxId)
        const [ownBinding] = await db.select().from(rankRelations).where(and(eq(rankRelations.groupId, groupId),
            eq(rankRelations.robloxId, roles.find(role => role.rank === ownRank)?.id ?? ''))).limit(1)
        const ownGrants = ownRank === 255 ? PERM.ADMINISTRATOR : ownBinding?.permissions ?? 0
        if (!target || target.rank >= ownRank || maximum >= ownRank || (!has(ownGrants, PERM.ADMINISTRATOR) && (rank.permissions & ~ownGrants) !== 0)) {
            throw status(403, 'You can only offer ranks and rank limits below your own Roblox rank' satisfies ClaimableModel.unsafe)
        }
    }
    return rank
}

export async function publicClaimablesFor(groupId: string) {
    return db.select({ id: claimableRanks.id, slug: claimableRanks.slug, name: claimableRanks.name, description: claimableRanks.description,
        color: claimableRanks.color, translations: claimableRanks.translations, rankName: rankRelations.cachedName })
        .from(claimableRanks).innerJoin(rankRelations, eq(claimableRanks.rankId, rankRelations.id))
        .where(and(eq(claimableRanks.groupId, groupId), eq(claimableRanks.enabled, true))).orderBy(asc(claimableRanks.name))
}
export abstract class Claimables {
    static async list(groupId: string, session: session): Promise<ClaimableModel.Item[]> {
        const group = await groupFor(groupId)
        await assertGroupPermission(session, group.id, PERM.MANAGE_CLAIMABLES)
        const rows = await db.select(selection).from(claimableRanks).leftJoin(rankRelations, eq(claimableRanks.rankId, rankRelations.id))
            .where(eq(claimableRanks.groupId, group.id)).orderBy(asc(claimableRanks.name))
        return rows.map(row => ({ ...row.claim, translations: presentTranslations('CLAIMABLE', row.claim.translations), rankName: row.rankName, rankColor: row.rankColor }))
    }
    static async ranks(groupId: string, session: session) {
        const group = await groupFor(groupId)
        await assertGroupPermission(session, group.id, PERM.MANAGE_CLAIMABLES)
        const rows = await db.select().from(rankRelations).where(eq(rankRelations.groupId, group.id)).orderBy(asc(rankRelations.cachedRank))
        return rows.filter(rank => rank.cachedRank > 0 && rank.cachedRank < 255).map(rank => ({ id: rank.id, name: rank.cachedName ?? rank.robloxId, rank: rank.cachedRank, color: rank.color }))
    }
    static async get(id: string, session: session) {
        const claim = await load(id)
        await assertGroupPermission(session, claim.groupId, PERM.MANAGE_CLAIMABLES)
        return claim
    }
    static async create(body: ClaimableModel.Create, session: session) {
        const group = await groupFor(body.groupId)
        if (!body.name.trim()) throw status(400, 'This claimable rank is unavailable')
        const [target] = await db.select().from(rankRelations).where(and(eq(rankRelations.id, body.rankId), eq(rankRelations.groupId, group.id))).limit(1)
        if (!target) throw status(400, 'This claimable rank is unavailable')
        await checkEditor(group.id, target.id, target.cachedRank, session)
        const taken = await db.select({ slug: claimableRanks.slug }).from(claimableRanks).where(eq(claimableRanks.groupId, group.id))
        const [claim] = await db.insert(claimableRanks).values({ groupId: group.id, rankId: target.id, name: body.name.trim(), color: target.color,
            maximumRank: target.cachedRank, slug: uniqueWithin(childSlug('claim', body.name, crypto.randomUUID()), new Set(taken.map(row => row.slug))) }).returning()
        await recordAudit(group.id, session.user!.userId, 'claimable.create', `Created claimable rank ${body.name}`)
        return load(claim!.id)
    }
    static async patch(id: string, body: ClaimableModel.Patch, session: session) {
        const claim = await load(id)
        if (body.name !== undefined && !body.name.trim()) throw status(400, 'This claimable rank is unavailable')
        const rankId = body.rankId ?? claim.rankId
        if (!rankId) throw status(400, 'This claimable rank is unavailable')
        await checkEditor(claim.groupId, rankId, body.maximumRank ?? claim.maximumRank, session)
        if (body.enabled) await cloudFor(claim.groupId)
        await db.update(claimableRanks).set({ ...body, translations: mergeTranslations('CLAIMABLE', claim.translations, body.translations), ...(body.name ? { name: body.name.trim() } : {}) }).where(eq(claimableRanks.id, id))
        await recordAudit(claim.groupId, session.user!.userId, 'claimable.update', `Updated claimable rank ${claim.name}`)
        return load(id)
    }
    static async remove(id: string, session: session) {
        const claim = await load(id)
        await assertGroupPermission(session, claim.groupId, PERM.MANAGE_CLAIMABLES)
        await db.delete(claimableRanks).where(eq(claimableRanks.id, id))
        await recordAudit(claim.groupId, session.user!.userId, 'claimable.delete', `Deleted claimable rank ${claim.name}`)
        return 'Success' as const
    }
    static async connection(groupId: string, session: session) {
        const group = await groupFor(groupId)
        const user = requireUser(session)
        await assertGroupPermission(session, group.id, PERM.MANAGE_CLAIMABLES)
        const { accessToken } = await userCredentials(user.userId, true)
        const [profile] = await db.select({ scopes: users.robloxWriteScopes }).from(users).where(eq(users.id, user.userId)).limit(1)
        const [connection] = await db.select().from(claimableConnections).where(eq(claimableConnections.groupId, group.id)).limit(1)
        let connected = false
        try { await cloudFor(group.id); connected = true } catch { /* Reconnection is shown on the dashboard. */ }
        return { hasWriteScope: Boolean(accessToken && profile?.scopes.split(' ').includes('group:write')), connected, authorizedByMe: connection?.authorizedBy === user.userId }
    }
    static async connect(groupId: string, session: session) {
        const group = await groupFor(groupId)
        const user = requireUser(session)
        if (session.viaApiKey) throw status(403, 'Forbidden')
        await assertGroupPermission(session, group.id, PERM.MANAGE_CLAIMABLES)
        const { accessToken } = await userCredentials(user.userId, true)
        const [profile] = await db.select().from(users).where(eq(users.id, user.userId)).limit(1)
        if (!accessToken || !profile?.robloxWriteScopes.split(' ').includes('group:write')) throw status(503, 'The group needs to reconnect Roblox rank changes')
        const cloud = new RankCloud(accessToken)
        const membership = await cloud.membership(group.robloxId, user.robloxId)
        if (!membership || highestRank(membership, await cloud.roles(group.robloxId)) <= 1) throw status(403, 'Forbidden')
        await db.insert(claimableConnections).values({ groupId: group.id, authorizedBy: user.userId })
            .onConflictDoUpdate({ target: claimableConnections.groupId, set: { authorizedBy: user.userId } })
        await recordAudit(group.id, user.userId, 'claimable.connect', 'Connected Roblox rank changes')
        return 'Success' as const
    }
    static async disconnect(groupId: string, session: session) {
        const group = await groupFor(groupId)
        await assertGroupPermission(session, group.id, PERM.MANAGE_CLAIMABLES)
        await db.delete(claimableConnections).where(eq(claimableConnections.groupId, group.id))
        await recordAudit(group.id, requireUser(session).userId, 'claimable.disconnect', 'Disconnected Roblox rank changes')
        return 'Success' as const
    }
    static async publicPage(groupSlug: string, claimSlug: string) {
        const [row] = await db.select({ id: claimableRanks.id }).from(claimableRanks).innerJoin(groups, eq(claimableRanks.groupId, groups.id))
            .where(and(eq(groups.slug, groupSlug), eq(claimableRanks.slug, claimSlug))).limit(1)
        if (!row) throw status(404, 'This claimable rank is unavailable')
        return (await published(row.id)).claim
    }
    static async inspect(id: string, session: session) {
        const user = requireUser(session)
        const { claim, group } = await published(id)
        const [profile] = await db.select().from(users).where(eq(users.id, user.userId)).limit(1)
        if (profile && !profile.robloxCreatedAt && claim.minimumAccountAgeDays > 0) {
            const { accessToken } = await userCredentials(user.userId)
            const created = accessToken ? await robloxCreationDate(accessToken, user.robloxId) : null
            if (created) {
                await db.update(users).set({ robloxCreatedAt: created }).where(eq(users.id, user.userId))
                profile.robloxCreatedAt = created
            }
        }
        let currentRank: number | null = null, alreadyHeld = false, connected = false
        try {
            const { cloud } = await cloudFor(group.id)
            connected = true
            const roles = await cloud.roles(group.robloxId)
            const membership = await cloud.membership(group.robloxId, user.robloxId)
            currentRank = highestRank(membership, roles)
            const [binding] = await db.select().from(rankRelations).where(eq(rankRelations.id, claim.rankId!)).limit(1)
            alreadyHeld = Boolean(binding && membership && membershipRoles(membership).includes(`groups/${group.robloxId}/roles/${binding.robloxId}`) &&
                membershipRoles(membership).every(path => path.endsWith(`/roles/${binding.robloxId}`) || (roles.find(role => path.endsWith(`/roles/${role.id}`))?.rank ?? Infinity) <= 1))
        } catch { /* Unknown qualifications fail closed; they are never a demotion. */ }
        const checks = qualifications({ ...claim, connected, currentRank, createdAt: profile?.robloxCreatedAt ?? null, discordLinked: Boolean(profile?.discordId) })
        const rawPending = await dataRedis.get(pendingKey(group.id, user.userId))
        const pending = Boolean(rawPending && (JSON.parse(rawPending) as Pending).claimId === id)
        return { ...checks, pending, connected, currentRank, alreadyHeld, canClaim: checks.canClaim && !alreadyHeld }
    }
    static async claim(id: string, session: session) {
        const user = requireUser(session)
        if (session.viaApiKey) throw status(403, 'Forbidden')
        const { claim, group } = await published(id)
        const key = pendingKey(group.id, user.userId)
        const existing = await dataRedis.get(key)
        if (existing) {
            const pending = JSON.parse(existing) as Pending
            if (pending.claimId !== id) throw status(409, 'Conflict')
            return { state: 'PENDING' as const }
        }
        const lock = JSON.stringify({ claimId: id, target: '', removed: [], robloxId: group.robloxId, name: claim.name } satisfies Pending)
        if (!(await dataRedis.set(key, lock, 'EX', 600, 'NX'))) throw status(409, 'Conflict')
        await dataRedis.del(`${key}:confirmed:${id}`)
        try {
            const { cloud, writer } = await cloudFor(group.id)
            const roles = await cloud.roles(group.robloxId)
            const [membership, writerMembership, profile, binding] = await Promise.all([
                cloud.membership(group.robloxId, user.robloxId), cloud.membership(group.robloxId, writer.robloxId),
                db.select().from(users).where(eq(users.id, user.userId)).limit(1),
                db.select().from(rankRelations).where(eq(rankRelations.id, claim.rankId!)).limit(1)
            ])
            const currentRank = highestRank(membership, roles), writerRank = highestRank(writerMembership, roles)
            const [writerBinding] = await db.select().from(rankRelations).where(and(eq(rankRelations.groupId, group.id), eq(rankRelations.robloxId, roles.find(role => role.rank === writerRank)?.id ?? ''))).limit(1)
            const target = roles.find(role => role.id === binding[0]?.robloxId)
            const writerGrants = writerRank === 255 ? PERM.ADMINISTRATOR : writerBinding?.permissions ?? 0
            if (!target || target.rank < 1 || target.rank >= writerRank || currentRank >= writerRank || writer.robloxId === user.robloxId ||
                !has(writerGrants, PERM.MANAGE_CLAIMABLES) ||
                (!has(writerGrants, PERM.ADMINISTRATOR) && ((binding[0]?.permissions ?? 0) & ~writerGrants) !== 0)) {
                throw status(503, 'The group needs to reconnect Roblox rank changes')
            }
            const checks = qualifications({ ...claim, currentRank, connected: true, createdAt: profile[0]?.robloxCreatedAt ?? null, discordLinked: Boolean(profile[0]?.discordId) })
            if (!checks.canClaim || !membership) throw status(403, 'You do not meet the requirements for this rank' satisfies ClaimableModel.ineligible)
            const targetPath = `groups/${group.robloxId}/roles/${target.id}`
            const removed = membershipRoles(membership).filter(role => role !== targetPath && roles.find(item => role.endsWith(`/roles/${item.id}`))!.rank > 1)
            await dataRedis.set(key, JSON.stringify({ claimId: id, target: targetPath, removed, robloxId: group.robloxId, name: claim.name } satisfies Pending), 'EX', 600)
            await cloud.change(membership, targetPath, removed)
            return { state: 'PENDING' as const }
        } catch (error) {
            // A failed write may have reached Roblox. Clear local permissions even
            // then; the next read must resolve the actual remaining roles.
            await Claimables.invalidate(group.id, group.robloxId, user.userId, user.robloxId)
            await dataRedis.del(key)
            if (error instanceof RateLimitError || (error && typeof error === 'object' && 'code' in error)) throw error
            console.warn('[claimables] rank change failed', error instanceof Error ? error.message : 'unknown')
            throw status(503, 'Roblox could not change your rank. Check your rank and try again' satisfies ClaimableModel.rejected)
        }
    }
    static async confirm(id: string, session: session) {
        const user = requireUser(session)
        // An in-flight change remains readable even if the group closes the offer.
        const claim = await load(id)
        const key = pendingKey(claim.groupId, user.userId)
        const raw = await dataRedis.get(key)
        const completed = !raw ? await dataRedis.get(`${key}:confirmed:${id}`) : null
        if (!raw && !completed) throw status(409, 'Conflict')
        const pending = JSON.parse(raw ?? completed!) as Pending
        if (pending.claimId !== id || !pending.target) return { state: 'PENDING' as const }
        const { cloud } = await cloudFor(claim.groupId)
        const membership = await cloud.membership(pending.robloxId, user.robloxId)
        if (!membership || !confirmedRoles(membershipRoles(membership), pending.target, pending.removed)) return { state: 'PENDING' as const }
        await Claimables.invalidate(claim.groupId, pending.robloxId, user.userId, user.robloxId)
        // Consume once so repeated status calls cannot duplicate the audit entry.
        const consumed = raw ? await dataRedis.eval<number>("if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], ARGV[1], 'EX', 600); return redis.call('del', KEYS[1]) else return 0 end", [key, `${key}:confirmed:${id}`], [raw]) : 0
        if (consumed) await recordAudit(claim.groupId, user.userId, 'claimable.claim', `Claimed ${pending.name}; Roblox confirmed the rank change`)
        return { state: 'CONFIRMED' as const }
    }
    private static async invalidate(groupId: string, robloxId: string, userId: string, robloxUserId: number) {
        await Promise.all([invalidateUserPermissions(userId), dataRedis.del(`perm:last:${groupId}:${userId}`, `roblox:membership:${robloxId}:${robloxUserId}`, `roblox:usergroups:${robloxUserId}`), deleteByPattern(`roblox:rolemembers:${robloxId}:*`)])
    }
}
