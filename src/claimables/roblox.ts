const BASE = 'https://apis.roblox.com/cloud/v2'
export interface CloudMembership { path: string; user: string; role?: string; roles?: string[] }
export interface CloudRole { id: string; displayName: string; rank: number }

// Reads deliberately bypass the ordinary membership cache and its outage grace.
// Neither is evidence that a rank change has reached Roblox.
export class RankCloud {
    constructor(private token: string, private request: (input: string, init?: RequestInit) => Promise<Response> = fetch) {}
    private async json<T>(path: string, body?: object): Promise<T> {
        const response = await this.request(`${BASE}${path}`, {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            cache: 'no-store', signal: AbortSignal.timeout(10_000)
        })
        if (!response.ok) throw new Error(`Roblox rank request returned ${response.status}`)
        return await response.json() as T
    }
    async membership(group: number | string, user: number): Promise<CloudMembership | null> {
        const result = await this.json<{ groupMemberships: CloudMembership[] }>(
            `/groups/${group}/memberships?maxPageSize=1&filter=${encodeURIComponent(`user == 'users/${user}'`)}`)
        if (!Array.isArray(result.groupMemberships)) throw new Error('Missing memberships')
        const entry = result.groupMemberships[0] ?? null
        if (entry && (entry.user !== `users/${user}` || !entry.path.startsWith(`groups/${group}/memberships/`))) {
            throw new Error('Mismatched membership')
        }
        return entry
    }
    async roles(group: number | string): Promise<CloudRole[]> {
        const all: CloudRole[] = []
        let token = ''
        for (let page = 0; page < 20; page++) {
            const result = await this.json<{ groupRoles: CloudRole[]; nextPageToken?: string }>(
                `/groups/${group}/roles?maxPageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`)
            if (!Array.isArray(result.groupRoles)) throw new Error('Missing roles')
            all.push(...result.groupRoles)
            token = result.nextPageToken ?? ''
            if (!token) return all
        }
        throw new Error('Too many role pages')
    }
    async change(membership: CloudMembership, target: string, previous: string[]) {
        // Assign first so a failed removal can never leave somebody with no role.
        // The deprecated PATCH cannot represent Roblox's multiple-role memberships.
        await this.json(`/${membership.path}:assignRole`, { role: target })
        for (const role of previous) await this.json(`/${membership.path}:unassignRole`, { role })
    }
}
export function membershipRoles(membership: CloudMembership): string[] {
    const roles = membership.roles ?? (membership.role ? [membership.role] : [])
    if (roles.length === 0) throw new Error('Missing membership roles')
    return roles
}
export function highestRank(membership: CloudMembership | null, roles: CloudRole[]): number {
    if (!membership) return -1
    const assigned = membershipRoles(membership).map(path => roles.find(role => path.endsWith(`/roles/${role.id}`))?.rank)
    if (assigned.some(rank => rank === undefined)) throw new Error('Unrecognized Roblox role')
    return Math.max(...assigned as number[])
}
