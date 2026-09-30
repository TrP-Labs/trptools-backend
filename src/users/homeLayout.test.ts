import { expect, test } from 'bun:test'
import { DEFAULT_HOME_LAYOUT, validHomeLayout } from './homeLayout'
test('home defaults are valid and the two profiles stay independent', () => {
    expect(validHomeLayout(DEFAULT_HOME_LAYOUT)).toBe(true)
    const layout = structuredClone(DEFAULT_HOME_LAYOUT)
    layout.user.reverse()
    expect(layout.host).toEqual(DEFAULT_HOME_LAYOUT.host)
    expect(validHomeLayout({ user: [], host: [] })).toBe(true)
})
test('layouts reject duplicates, cross-mode widgets, unknown ids and invalid widths', () => {
    for (const user of [[{ id: 'next', width: 1 }, { id: 'next', width: 2 }], [{ id: 'reviews', width: 1 }], [{ id: 'unknown', width: 1 }], [{ id: 'next', width: 3 }]]) {
        expect(validHomeLayout({ user, host: [] })).toBe(false)
    }
})
