import { test, expect } from 'bun:test'
import { normalizeDiscordInvite as invite } from './joinLinks'
test('canonical invite URLs and clearing', () => {
    expect(invite(' Ab-Cd ')).toBe('https://discord.gg/Ab-Cd')
    expect(invite('https://discord.com/invite/AbCd/')).toBe('https://discord.gg/AbCd')
    expect(invite('https://discord.gg/AbCd')).toBe('https://discord.gg/AbCd')
    expect(invite('')).toBe('')
})
test('rejects arbitrary destinations and ambiguous URLs', () => {
    for (const url of ['http://discord.gg/abc', 'https://discord.gg.evil.com/abc', 'https://discord.gg@evil.com/abc', 'https://discord.gg/abc?redirect=evil', 'javascript:alert(1)', 'https://discord.gg:444/abc', 'https://discord.com/abc', 'https://discord.gg/abc#x']) expect(invite(url)).toBeNull()
})
