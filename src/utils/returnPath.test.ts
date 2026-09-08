import { describe, expect, test } from 'bun:test'
import { DEFAULT_RETURN_PATH, safeReturnPath } from './returnPath'

/**
 * The Discord callback redirects the browser to whatever was parked with the
 * OAuth state. Anything a browser would read as another origin has to be
 * refused, or the site is an open redirect with an OAuth round trip attached.
 */
describe('safeReturnPath', () => {
    test('keeps an ordinary site path', () => {
        expect(safeReturnPath('/g/demo/apply/driver')).toBe('/g/demo/apply/driver')
        expect(safeReturnPath('/dashboard/demo/shifts?tab=1')).toBe('/dashboard/demo/shifts?tab=1')
    })

    test('falls back when nothing was asked for', () => {
        expect(safeReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH)
        expect(safeReturnPath(null)).toBe(DEFAULT_RETURN_PATH)
        expect(safeReturnPath('')).toBe(DEFAULT_RETURN_PATH)
    })

    test('refuses anything a browser would read as another origin', () => {
        expect(safeReturnPath('https://evil.example')).toBe(DEFAULT_RETURN_PATH)
        // Protocol-relative: a browser reads this as a host, not a path.
        expect(safeReturnPath('//evil.example')).toBe(DEFAULT_RETURN_PATH)
        // Browsers normalise a backslash to a slash, so this is `//evil…`.
        expect(safeReturnPath('/\\evil.example')).toBe(DEFAULT_RETURN_PATH)
        expect(safeReturnPath('\\\\evil.example')).toBe(DEFAULT_RETURN_PATH)
        expect(safeReturnPath('javascript:alert(1)')).toBe(DEFAULT_RETURN_PATH)
        // No leading slash at all is a relative path, which resolves against
        // the callback's own address rather than the site root.
        expect(safeReturnPath('settings')).toBe(DEFAULT_RETURN_PATH)
    })
})
