import { eq } from 'drizzle-orm'
import db from '../db'
import { botConfigs, type BotConfig, type Group } from '../db/schema'
import { Roblox } from '../utils/roblox'
import { groupCredentials } from '../utils/robloxCredentials'

/**
 * Whose private server a shift's join link opens.
 *
 * Always the Roblox group's owner. It used to be a free text field on the bot
 * page, which meant every announcement could be pointed at an account that had
 * since left the group, and nothing on the page would say so. A host who needs
 * a different server for one shift sets it on that occurrence with
 * `/edit-shift` instead — a temporary override that expires with the shift,
 * rather than a permanent setting nobody remembers changing.
 *
 * Roblox is the source of truth, and the answer is written back to the config
 * row. That row is a cache, not a setting: when Roblox is unreachable the last
 * known owner is used, because the alternative is a link with no `Server` in
 * it, which drops everyone into the public game rather than the shift.
 */
export async function ownerRobloxId(config: BotConfig, group: Group): Promise<string | null> {
    const robloxGroup = await Roblox.getGroup(group.robloxId, await groupCredentials(group.id)).catch(() => null)
    const owner = robloxGroup?.ownerId ? String(robloxGroup.ownerId) : null

    if (!owner) return config.ownerRobloxId
    if (owner === config.ownerRobloxId) return owner

    await db
        .update(botConfigs)
        .set({ ownerRobloxId: owner })
        .where(eq(botConfigs.id, config.id))
        .catch(() => undefined)

    return owner
}
