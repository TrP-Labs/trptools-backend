import { expect, test } from 'bun:test'
import { publicItemReadable } from './visibility'

test('individual routes and depots honor the parent and item publication gates', () => {
    const group = { visibility: 'PUBLIC', moderation: 'VISIBLE', showRoutes: true }
    const item = { visibility: 'PUBLIC', moderation: 'VISIBLE', archived: false }
    for (const kind of ['ROUTE', 'DEPOT'] as const) {
        expect(publicItemReadable(group, item, kind)).toBe(true)
        expect(publicItemReadable({ ...group, visibility: 'UNLISTED' }, item, kind)).toBe(true)
        expect(publicItemReadable({ ...group, visibility: 'PRIVATE' }, item, kind)).toBe(false)
        expect(publicItemReadable({ ...group, moderation: 'HIDDEN' }, item, kind)).toBe(false)
        for (const patch of [{ archived: true }, { moderation: 'HIDDEN' }, { visibility: 'PRIVATE' }, { visibility: 'UNLISTED' }]) {
            expect(publicItemReadable(group, { ...item, ...patch }, kind)).toBe(false)
        }
    }
    expect(publicItemReadable({ ...group, showRoutes: false }, item, 'ROUTE')).toBe(false)
    expect(publicItemReadable({ ...group, showRoutes: false }, item, 'DEPOT')).toBe(true)
})
