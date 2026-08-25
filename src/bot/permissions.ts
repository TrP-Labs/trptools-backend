/**
 * Discord's permission arithmetic, and the shapes it operates on.
 *
 * Split out from `discord.ts` because that module opens with `env` and Redis,
 * so a test that imports it needs an environment — which CI does not have, and
 * which is how a suite that passes locally takes a release down. This half
 * imports nothing at all, and `discord.ts` re-exports it, so nothing that
 * already imports from there has to change.
 *
 * Permission bits exceed 2^53 (`SEND_POLLS` is bit 49), so every value here is
 * a BigInt and a stray `Number()` would lose it.
 */

export const PERMISSIONS = {
    ADMINISTRATOR: 1n << 3n,
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
    EMBED_LINKS: 1n << 14n,
    ATTACH_FILES: 1n << 15n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    MENTION_EVERYONE: 1n << 17n,
    SEND_POLLS: 1n << 49n
} as const

export type PermissionName = keyof typeof PERMISSIONS

/**
 * What the bot is invited with, and what the dashboard checks it still has.
 *
 * `MANAGE_MESSAGES` is for the end-of-shift cleanup, `MENTION_EVERYONE` so a
 * ping role that is not itself mentionable still works, `SEND_POLLS` for the
 * satisfaction poll. Everything else is the minimum to post an embed with an
 * image attached and edit it later.
 */
export const REQUIRED_PERMISSIONS: PermissionName[] = [
    'VIEW_CHANNEL',
    'SEND_MESSAGES',
    'EMBED_LINKS',
    'ATTACH_FILES',
    'READ_MESSAGE_HISTORY',
    'MANAGE_MESSAGES',
    'MENTION_EVERYONE',
    'SEND_POLLS'
]

export const INVITE_PERMISSIONS = REQUIRED_PERMISSIONS.reduce((total, name) => total | PERMISSIONS[name], 0n)

// --- Raw Discord shapes, narrowed to what we read ---------------------------

export type DiscordGuild = {
    id: string
    name: string
    icon: string | null
    owner_id?: string
}

export type DiscordRole = {
    id: string
    name: string
    color: number
    position: number
    permissions: string
    managed: boolean
    mentionable: boolean
}

export type DiscordChannel = {
    id: string
    type: number
    name?: string
    position?: number
    parent_id?: string | null
    permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>
}

export type DiscordMember = {
    roles: string[]
    user?: { id: string }
}

/** Channel types the bot can post into. 0 text, 5 announcement, 11/12 threads. */
export const POSTABLE_CHANNEL_TYPES = new Set([0, 5, 11, 12])
/** Category, so the picker can group channels under their parent. */
export const CATEGORY_CHANNEL_TYPE = 4

export function channelPermissions(
    channel: DiscordChannel,
    roles: DiscordRole[],
    memberRoleIds: string[],
    guildId: string,
    botUserId: string
): bigint {
    const everyone = roles.find((role) => role.id === guildId)
    let permissions = BigInt(everyone?.permissions ?? '0')

    for (const roleId of memberRoleIds) {
        const role = roles.find((candidate) => candidate.id === roleId)
        if (role) permissions |= BigInt(role.permissions)
    }

    // Administrator short-circuits everything, overwrites included.
    if (permissions & PERMISSIONS.ADMINISTRATOR) {
        return Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0n)
    }

    const overwrites = channel.permission_overwrites ?? []

    const everyoneOverwrite = overwrites.find((overwrite) => overwrite.id === guildId)
    if (everyoneOverwrite) {
        permissions &= ~BigInt(everyoneOverwrite.deny)
        permissions |= BigInt(everyoneOverwrite.allow)
    }

    // Role overwrites accumulate before being applied, so a deny on one role
    // does not beat an allow on another the bot also holds.
    let allow = 0n
    let deny = 0n
    for (const overwrite of overwrites) {
        if (overwrite.type !== 0 || overwrite.id === guildId) continue
        if (!memberRoleIds.includes(overwrite.id)) continue
        allow |= BigInt(overwrite.allow)
        deny |= BigInt(overwrite.deny)
    }
    permissions &= ~deny
    permissions |= allow

    const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === botUserId)
    if (memberOverwrite) {
        permissions &= ~BigInt(memberOverwrite.deny)
        permissions |= BigInt(memberOverwrite.allow)
    }

    return permissions
}

/** Guild-wide permissions, before any channel overwrite. */
export function guildPermissions(roles: DiscordRole[], memberRoleIds: string[], guildId: string): bigint {
    const everyone = roles.find((role) => role.id === guildId)
    let permissions = BigInt(everyone?.permissions ?? '0')

    for (const roleId of memberRoleIds) {
        const role = roles.find((candidate) => candidate.id === roleId)
        if (role) permissions |= BigInt(role.permissions)
    }

    if (permissions & PERMISSIONS.ADMINISTRATOR) {
        return Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0n)
    }

    return permissions
}

export function has(permissions: bigint, name: PermissionName): boolean {
    return (permissions & PERMISSIONS[name]) === PERMISSIONS[name]
}
