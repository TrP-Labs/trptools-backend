import { expect, test } from 'bun:test'
import { canRegisterGroup } from './registration'

test('an elevated site admin can register another owner\'s group by ID', () => {
    expect(canRegisterGroup(true, 1, 2)).toBe(true)
})

test('an ordinary user still needs Roblox ownership', () => {
    expect(canRegisterGroup(false, 1, 2, 200)).toBe(false)
    expect(canRegisterGroup(false, 1, 1)).toBe(true)
    expect(canRegisterGroup(false, 1, 2, 255)).toBe(true)
})
