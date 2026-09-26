import { expect, test } from 'bun:test'
import { manifestVersion, matchesManifestVersion } from './manifestVersion'

test('a stable board version matches weak validators and lists', async () => {
    const etag = await manifestVersion({ roomId: 'r', vehicles: [{ id: '10', assigned: false }] })
    expect(await manifestVersion({ roomId: 'r', vehicles: [{ id: '10', assigned: false }] })).toBe(etag)
    expect(matchesManifestVersion(`"other", ${etag}`, etag)).toBe(true)
    expect(matchesManifestVersion('*', etag)).toBe(true)
    expect(matchesManifestVersion(null, etag)).toBe(false)
    expect(matchesManifestVersion('"other"', etag)).toBe(false)
    expect(await manifestVersion({ roomId: 'r', vehicles: [{ id: '10', assigned: true }] })).not.toBe(etag)
    expect(await manifestVersion({ roomId: 'replacement', vehicles: [{ id: '10', assigned: false }] })).not.toBe(etag)
})
