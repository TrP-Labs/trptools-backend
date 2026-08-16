import { dataRedis } from './redis'
import { env } from './env'

/**
 * Roblox API client.
 *
 * Roblox has moved group and user reads onto Open Cloud v2, which rejects
 * anonymous requests outright. The legacy `groups.roblox.com` endpoints still
 * answer without credentials today, but they are explicitly marked legacy and
 * are being gated progressively, so they cannot be the foundation.
 *
 * The complication is rate limits. Open Cloud caps a single OAuth
 * authorization at 30 requests/minute for GetGroup and 90/minute for roles and
 * memberships, while an API key owner gets 150 and 300. TrPTools resolves a
 * permission level on nearly every request, so a user's own token is far too
 * small a budget to build on.
 *
 * So credentials are tried in this order:
 *
 *   1. The Open Cloud API key a manager supplied for the group. Highest
 *      limits, works while nobody is signed in. It is stored against the group
 *      but must be *owned by a user account* — Open Cloud answers a group-owned
 *      key with 401 "Unsupported authorization method" on every group route,
 *      whatever permissions it was given.
 *   2. An instance-wide Open Cloud API key, if the operator configured one.
 *   3. The requesting user's OAuth access token (`group:read`).
 *   4. The legacy endpoints, so a group can onboard before wiring up a key.
 *
 * Every response is cached in Redis. With permission checks cached for a
 * minute, a busy dispatch room costs a couple of Roblox calls per minute
 * rather than hundreds.
 */

const OPEN_CLOUD = 'https://apis.roblox.com/cloud/v2'
const LEGACY_GROUPS = 'https://groups.roblox.com'
const LEGACY_USERS = 'https://users.roblox.com/v1'
const LEGACY_THUMBNAILS = 'https://thumbnails.roblox.com/v1'

const TTL = {
    group: 60 * 15,
    roles: 60 * 10,
    membership: 60,
    userGroups: 60 * 2,
    user: 60 * 30,
    thumbnail: 60 * 60 * 6,
    negative: 30
}

export interface RobloxGroup {
    id: number
    name: string
    description: string
    memberCount: number
    ownerId: number | null
}

export interface RobloxRole {
    id: string
    name: string
    rank: number
    memberCount?: number
}

export interface RobloxMembership {
    groupId: number
    groupName?: string
    role: RobloxRole
}

export interface RobloxUser {
    id: number
    name: string
    displayName: string
}

/**
 * Why Roblox refused an Open Cloud key.
 *
 * `GROUP_OWNED` is the one worth separating: Open Cloud accepts only keys
 * owned by a user account, so a key created under the group is refused
 * outright no matter what permissions it carries.
 */
export type ApiKeyRejection = 'GROUP_OWNED' | 'REJECTED' | 'NO_ACCESS' | 'RATE_LIMITED' | 'UNREACHABLE'

export type ApiKeyCheck = { ok: true } | { ok: false; reason: ApiKeyRejection }

/** Credentials a caller can offer for a given lookup, best first. */
export interface RobloxCredentials {
    /** Open Cloud API key belonging to the group being read. */
    apiKey?: string | null
    /** OAuth access token belonging to the user making the request. */
    accessToken?: string | null
}

async function cached<T>(key: string, ttl: number, produce: () => Promise<T>): Promise<T> {
    try {
        const hit = await dataRedis.get(key)
        if (hit !== null) return JSON.parse(hit) as T
    } catch {
        // A cache failure must never break the request path.
    }

    const value = await produce()

    try {
        // Cache misses are cached too, briefly, so a bad id cannot be used to
        // hammer Roblox through us.
        await dataRedis.set(key, JSON.stringify(value), 'EX', value === null ? TTL.negative : ttl)
    } catch {
        // ignore
    }

    return value
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T | null> {
    try {
        const response = await fetch(url, {
            ...init,
            headers: { Accept: 'application/json', ...(init.headers ?? {}) },
            signal: AbortSignal.timeout(10_000)
        })

        if (!response.ok) return null
        return (await response.json()) as T
    } catch {
        return null
    }
}

/** Runs an Open Cloud request against each available credential in turn. */
async function openCloud<T>(path: string, credentials: RobloxCredentials): Promise<T | null> {
    const attempts: Array<Record<string, string>> = []

    if (credentials.apiKey) attempts.push({ 'x-api-key': credentials.apiKey })
    if (env.ROBLOX_API_KEY) attempts.push({ 'x-api-key': env.ROBLOX_API_KEY })
    if (credentials.accessToken) attempts.push({ Authorization: `Bearer ${credentials.accessToken}` })

    for (const headers of attempts) {
        const result = await request<T>(`${OPEN_CLOUD}${path}`, { headers })
        if (result) return result
    }

    return null
}

/** `groups/7/roles/99513316` → `99513316` */
function lastPathSegment(resourcePath: string | undefined): string | null {
    if (!resourcePath) return null
    const segment = resourcePath.split('/').pop()
    return segment && segment.length > 0 ? segment : null
}

export abstract class Roblox {
    // ---------------------------------------------------------------- groups

    static async getGroup(groupId: number | string, credentials: RobloxCredentials = {}): Promise<RobloxGroup | null> {
        return cached(`roblox:group:${groupId}`, TTL.group, async () => {
            const cloud = await openCloud<{
                id: string
                displayName: string
                description: string
                memberCount: number
                owner?: string
            }>(`/groups/${groupId}`, credentials)

            if (cloud) {
                return {
                    id: Number(cloud.id),
                    name: cloud.displayName,
                    description: cloud.description ?? '',
                    memberCount: cloud.memberCount ?? 0,
                    ownerId: Number(lastPathSegment(cloud.owner)) || null
                }
            }

            const legacy = await request<{
                id: number
                name: string
                description: string
                memberCount: number
                owner: { userId: number } | null
            }>(`${LEGACY_GROUPS}/v1/groups/${groupId}`)

            if (!legacy) return null

            return {
                id: legacy.id,
                name: legacy.name,
                description: legacy.description ?? '',
                memberCount: legacy.memberCount ?? 0,
                ownerId: legacy.owner?.userId ?? null
            }
        })
    }

    static async getRoles(groupId: number | string, credentials: RobloxCredentials = {}): Promise<RobloxRole[]> {
        return cached(`roblox:roles:${groupId}`, TTL.roles, async () => {
            const cloud = await openCloud<{
                groupRoles?: Array<{ id: string; displayName: string; rank: number; memberCount?: number }>
            }>(`/groups/${groupId}/roles?maxPageSize=100`, credentials)

            if (cloud?.groupRoles) {
                return cloud.groupRoles.map((role) => ({
                    id: role.id,
                    name: role.displayName,
                    rank: role.rank,
                    memberCount: role.memberCount
                }))
            }

            const legacy = await request<{ roles: Array<{ id: number; name: string; rank: number; memberCount?: number }> }>(
                `${LEGACY_GROUPS}/v1/groups/${groupId}/roles`
            )

            return (legacy?.roles ?? []).map((role) => ({
                id: role.id.toString(),
                name: role.name,
                rank: role.rank,
                memberCount: role.memberCount
            }))
        })
    }

    static async getRoleById(
        groupId: number | string,
        roleId: string | number,
        credentials: RobloxCredentials = {}
    ): Promise<RobloxRole | null> {
        const roles = await this.getRoles(groupId, credentials)
        return roles.find((role) => role.id === roleId.toString()) ?? null
    }

    static async getRoleByRank(
        groupId: number | string,
        rank: number,
        credentials: RobloxCredentials = {}
    ): Promise<RobloxRole | null> {
        const roles = await this.getRoles(groupId, credentials)
        return roles.find((role) => role.rank === rank) ?? null
    }

    /**
     * The role a user holds in one specific group.
     *
     * This is the hot path — every permission check lands here — so it is
     * cached aggressively and prefers the group's own API key.
     */
    static async getMembership(
        robloxUserId: number | string,
        groupId: number | string,
        credentials: RobloxCredentials = {}
    ): Promise<RobloxMembership | null> {
        return cached(`roblox:membership:${groupId}:${robloxUserId}`, TTL.membership, async () => {
            const filter = encodeURIComponent(`user == 'users/${robloxUserId}'`)
            const cloud = await openCloud<{
                groupMemberships?: Array<{ user: string; role: string }>
            }>(`/groups/${groupId}/memberships?maxPageSize=1&filter=${filter}`, credentials)

            if (cloud?.groupMemberships?.length) {
                const membership = cloud.groupMemberships[0]!
                const roleId = lastPathSegment(membership.role)
                if (roleId) {
                    const role = await this.getRoleById(groupId, roleId, credentials)
                    if (role) return { groupId: Number(groupId), role }
                    return { groupId: Number(groupId), role: { id: roleId, name: 'Unknown', rank: 0 } }
                }
            }

            // Open Cloud returns an empty list for a non-member, which is a
            // real answer — but it also returns null when we have no usable
            // credential, and those must not be confused. Only fall through to
            // the legacy path when Open Cloud gave us nothing at all.
            if (cloud) return null

            const legacy = await request<{
                data: Array<{ group: { id: number; name: string }; role: { id: number; name: string; rank: number } }>
            }>(`${LEGACY_GROUPS}/v2/users/${robloxUserId}/groups/roles`)

            const entry = legacy?.data?.find((item) => item.group.id.toString() === groupId.toString())
            if (!entry) return null

            return {
                groupId: entry.group.id,
                groupName: entry.group.name,
                role: {
                    id: entry.role.id.toString(),
                    name: entry.role.name,
                    rank: entry.role.rank
                }
            }
        })
    }

    /**
     * Every group a user belongs to.
     *
     * Open Cloud has no "list a user's groups" endpoint — memberships are only
     * queryable per group — so this genuinely requires the legacy endpoint. It
     * is used for group discovery, not for authorization, and a failure here
     * degrades to an empty list rather than granting anything.
     */
    static async getUserGroups(robloxUserId: number | string): Promise<RobloxMembership[]> {
        return cached(`roblox:usergroups:${robloxUserId}`, TTL.userGroups, async () => {
            const legacy = await request<{
                data: Array<{
                    group: { id: number; name: string; memberCount: number }
                    role: { id: number; name: string; rank: number }
                }>
            }>(`${LEGACY_GROUPS}/v2/users/${robloxUserId}/groups/roles`)

            return (legacy?.data ?? []).map((entry) => ({
                groupId: entry.group.id,
                groupName: entry.group.name,
                role: {
                    id: entry.role.id.toString(),
                    name: entry.role.name,
                    rank: entry.role.rank
                }
            }))
        })
    }

    /**
     * The people holding one role in a group.
     *
     * Open Cloud can only filter memberships by user, not by role, so the
     * roster genuinely needs the legacy per-role endpoint. It is a public,
     * cosmetic read — a failure degrades to an empty roster rather than
     * affecting anything that grants access.
     */
    static async getRoleMembers(
        groupId: number | string,
        roleId: string,
        limit = 50
    ): Promise<{ total: number; members: Array<{ userId: number; username: string; displayName: string }> }> {
        return cached(`roblox:rolemembers:${groupId}:${roleId}`, TTL.roles, async () => {
            const data = await request<{
                data: Array<{ userId: number; username: string; displayName: string }>
            }>(`${LEGACY_GROUPS}/v1/groups/${groupId}/roles/${roleId}/users?limit=100&sortOrder=Asc`)

            const members = data?.data ?? []

            return {
                total: members.length,
                members: members.slice(0, limit)
            }
        })
    }

    // ----------------------------------------------------------------- users

    static async getUser(robloxUserId: number | string, credentials: RobloxCredentials = {}): Promise<RobloxUser | null> {
        return cached(`roblox:user:${robloxUserId}`, TTL.user, async () => {
            const cloud = await openCloud<{ id: string; name: string; displayName: string }>(
                `/users/${robloxUserId}`,
                credentials
            )

            if (cloud) {
                return { id: Number(cloud.id), name: cloud.name, displayName: cloud.displayName }
            }

            const legacy = await request<{ id: number; name: string; displayName: string }>(
                `${LEGACY_USERS}/users/${robloxUserId}`
            )

            if (!legacy) return null
            return { id: legacy.id, name: legacy.name, displayName: legacy.displayName }
        })
    }

    /** Resolves many users in one round trip, hitting the cache where possible. */
    static async getUsers(ids: Array<number | string>): Promise<Map<string, RobloxUser>> {
        const unique = [...new Set(ids.map((id) => id.toString()))].filter((id) => id !== '0' && /^\d+$/.test(id))
        const resolved = new Map<string, RobloxUser>()
        if (unique.length === 0) return resolved

        const missing: string[] = []

        await Promise.all(
            unique.map(async (id) => {
                try {
                    const hit = await dataRedis.get(`roblox:user:${id}`)
                    if (hit !== null) {
                        const parsed = JSON.parse(hit) as RobloxUser | null
                        if (parsed) resolved.set(id, parsed)
                        return
                    }
                } catch {
                    // fall through to the network
                }
                missing.push(id)
            })
        )

        for (let index = 0; index < missing.length; index += 100) {
            const batch = missing.slice(index, index + 100)

            const data = await request<{ data: Array<{ id: number; name: string; displayName: string }> }>(
                `${LEGACY_USERS}/users`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch.map(Number), excludeBannedUsers: false })
                }
            )

            await Promise.all(
                (data?.data ?? []).map(async (user) => {
                    const value: RobloxUser = { id: user.id, name: user.name, displayName: user.displayName }
                    resolved.set(user.id.toString(), value)
                    await dataRedis.set(`roblox:user:${user.id}`, JSON.stringify(value), 'EX', TTL.user).catch(() => undefined)
                })
            )
        }

        return resolved
    }

    // ------------------------------------------------------------ thumbnails

    static async getGroupIcon(groupId: number | string): Promise<string | null> {
        return cached(`roblox:groupicon:${groupId}`, TTL.thumbnail, async () => {
            const data = await request<{ data: Array<{ imageUrl?: string }> }>(
                `${LEGACY_THUMBNAILS}/groups/icons?groupIds=${groupId}&size=420x420&format=Png&isCircular=false`
            )
            return data?.data?.[0]?.imageUrl ?? null
        })
    }

    static async getAvatar(robloxUserId: number | string): Promise<string | null> {
        return cached(`roblox:avatar:${robloxUserId}`, TTL.thumbnail, async () => {
            const data = await request<{ data: Array<{ imageUrl?: string }> }>(
                `${LEGACY_THUMBNAILS}/users/avatar-headshot?userIds=${robloxUserId}&size=150x150&format=Png&isCircular=false`
            )
            return data?.data?.[0]?.imageUrl ?? null
        })
    }

    static async getAvatars(ids: Array<number | string>): Promise<Map<string, string>> {
        const unique = [...new Set(ids.map((id) => id.toString()))].filter((id) => id !== '0' && /^\d+$/.test(id))
        const resolved = new Map<string, string>()
        if (unique.length === 0) return resolved

        const missing: string[] = []

        await Promise.all(
            unique.map(async (id) => {
                try {
                    const hit = await dataRedis.get(`roblox:avatar:${id}`)
                    if (hit !== null) {
                        const parsed = JSON.parse(hit) as string | null
                        if (typeof parsed === 'string') resolved.set(id, parsed)
                        return
                    }
                } catch {
                    // fall through
                }
                missing.push(id)
            })
        )

        for (let index = 0; index < missing.length; index += 100) {
            const batch = missing.slice(index, index + 100)

            const data = await request<{ data: Array<{ targetId: number; imageUrl?: string }> }>(
                `${LEGACY_THUMBNAILS}/users/avatar-headshot?userIds=${batch.join(',')}&size=150x150&format=Png&isCircular=false`
            )

            await Promise.all(
                (data?.data ?? []).map(async (entry) => {
                    if (!entry.imageUrl) return
                    resolved.set(entry.targetId.toString(), entry.imageUrl)
                    await dataRedis
                        .set(`roblox:avatar:${entry.targetId}`, JSON.stringify(entry.imageUrl), 'EX', TTL.thumbnail)
                        .catch(() => undefined)
                })
            )
        }

        return resolved
    }

    // ------------------------------------------------------------ management

    /**
     * Confirms an Open Cloud key can actually read a group before we store it.
     *
     * This reports *why* a key was refused rather than just that it was. The
     * common failure is a key owned by the group rather than by a person:
     * Roblox rejects those on every `/cloud/v2/groups` route, and no amount of
     * changing permissions on that key will help, so telling someone their key
     * "cannot read this group" sends them round a loop they cannot exit.
     */
    static async verifyApiKey(groupId: number | string, apiKey: string): Promise<ApiKeyCheck> {
        let response: Response

        try {
            response = await fetch(`${OPEN_CLOUD}/groups/${groupId}`, {
                headers: { Accept: 'application/json', 'x-api-key': apiKey },
                signal: AbortSignal.timeout(10_000)
            })
        } catch {
            return { ok: false, reason: 'UNREACHABLE' }
        }

        if (response.ok) return { ok: true }

        const body = await response.text().catch(() => '')

        // Roblox answers a group-owned key with
        // "Unsupported authorization method. Only OAuth tokens and User API
        // keys are supported at this time." Matching the wording is not ideal,
        // but the status alone does not separate this from a revoked key and
        // the two need very different advice.
        if (response.status === 401 && body.includes('Unsupported authorization method')) {
            return { ok: false, reason: 'GROUP_OWNED' }
        }

        if (response.status === 401) return { ok: false, reason: 'REJECTED' }
        if (response.status === 403 || response.status === 404) return { ok: false, reason: 'NO_ACCESS' }
        if (response.status === 429) return { ok: false, reason: 'RATE_LIMITED' }

        return { ok: false, reason: 'UNREACHABLE' }
    }

    static async invalidateGroup(groupId: number | string) {
        await dataRedis
            .del(`roblox:group:${groupId}`, `roblox:roles:${groupId}`, `roblox:groupicon:${groupId}`)
            .catch(() => undefined)

        const stream = dataRedis.scanStream({ match: `roblox:membership:${groupId}:*`, count: 500 })
        for await (const keys of stream) {
            if (keys.length) await dataRedis.unlink(...keys)
        }
    }
}
