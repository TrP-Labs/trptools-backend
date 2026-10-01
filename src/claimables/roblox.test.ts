import { expect, test } from 'bun:test'
import { RankCloud, highestRank, membershipRoles } from './roblox'
test('fresh reads authenticate with the manager token and filter the exact claimant', async () => {
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
        expect(init?.cache).toBe('no-store')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer manager')
        expect(new URL(String(url)).searchParams.get('filter')).toBe("user == 'users/7'")
        return Response.json({ groupMemberships: [{ path: 'groups/5/memberships/abc', user: 'users/7', role: 'groups/5/roles/10' }] })
    }) as typeof fetch
    expect((await new RankCloud('manager', request).membership(5, 7))?.path).toBe('groups/5/memberships/abc')
})
test('rank switching assigns before removing existing non-base roles using membership resource ids', async () => {
    const calls: string[] = []
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(new URL(String(url)).pathname + ' ' + JSON.parse(String(init?.body)).role)
        return Response.json({})
    }) as typeof fetch
    await new RankCloud('manager', request).change({ path: 'groups/5/memberships/abc', user: 'users/7' }, 'groups/5/roles/20', ['groups/5/roles/10', 'groups/5/roles/15'])
    expect(calls).toEqual(['/cloud/v2/groups/5/memberships/abc:assignRole groups/5/roles/20', '/cloud/v2/groups/5/memberships/abc:unassignRole groups/5/roles/10', '/cloud/v2/groups/5/memberships/abc:unassignRole groups/5/roles/15'])
})
test('a rejected assignment performs no removals', async () => {
    let calls = 0
    const request = (async () => { calls++; return new Response('', { status: 403 }) }) as unknown as typeof fetch
    await expect(new RankCloud('manager', request).change({ path: 'groups/5/memberships/abc', user: 'users/7' }, 'target', ['old'])).rejects.toThrow('403')
    expect(calls).toBe(1)
})
test('role ranking considers every role and refuses unknown roles', () => {
    const membership = { path: 'groups/5/memberships/a', user: 'users/7', role: 'groups/5/roles/10', roles: ['groups/5/roles/10', 'groups/5/roles/20'] }
    const roles = [{ id: '10', rank: 10, displayName: 'Driver' }, { id: '20', rank: 100, displayName: 'Host' }]
    expect(highestRank(membership, roles)).toBe(100)
    expect(highestRank(null, roles)).toBe(-1)
    expect(() => highestRank(membership, roles.slice(0, 1))).toThrow()
    expect(membershipRoles({ ...membership, roles: undefined })).toEqual(['groups/5/roles/10'])
})
