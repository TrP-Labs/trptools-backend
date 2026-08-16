import { env } from '../utils/env'
import { dataRedis } from '../utils/redis'

/**
 * A small Discord REST client, used by the API for the reads the dashboard
 * needs: which channels exist, which roles exist, and what the bot is
 * actually allowed to do in each.
 *
 * The bot process owns the gateway and every write. This talks to Discord
 * directly rather than asking the bot, so the dashboard keeps working — and
 * keeps saying *why* it is not working — while the bot is down.
 */

const API = 'https://discord.com/api/v10'

/** Discord permission bits, as the flags we actually depend on. */
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

export const discordConfigured = Boolean(env.DISCORD_APP_ID && env.DISCORD_BOT_TOKEN)

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

class DiscordError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

async function botRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json',
            ...init.headers
        }
    })

    if (!response.ok) {
        throw new DiscordError(response.status, `Discord ${init.method ?? 'GET'} ${path} → ${response.status}`)
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
}

/**
 * Reads that back the dashboard are cached briefly.
 *
 * Discord's per-route limits are generous but the bot page refetches on every
 * modal open, and a guild's channel list does not change by the second. The
 * refresh button in each picker deletes these keys, so "fetch newly created
 * channels" stays instant and deliberate rather than a matter of waiting.
 */
const CACHE_TTL = 60

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    try {
        const hit = await dataRedis.get(key)
        if (hit) return JSON.parse(hit) as T
    } catch {
        // A cache miss and a broken cache are the same thing here.
    }

    const value = await load()
    await dataRedis.set(key, JSON.stringify(value), 'EX', CACHE_TTL).catch(() => undefined)
    return value
}

const guildKey = (guildId: string) => `discord:guild:${guildId}`
const rolesKey = (guildId: string) => `discord:roles:${guildId}`
const channelsKey = (guildId: string) => `discord:channels:${guildId}`
const memberKey = (guildId: string) => `discord:member:${guildId}`

/** Drops every cached read for a guild, behind the pickers' refresh button. */
export async function invalidateGuild(guildId: string) {
    await dataRedis
        .del(guildKey(guildId), rolesKey(guildId), channelsKey(guildId), memberKey(guildId))
        .catch(() => undefined)
}

export const Discord = {
    /** Null when the bot is not in the guild, or was removed from it. */
    async getGuild(guildId: string): Promise<DiscordGuild | null> {
        return cached(guildKey(guildId), () =>
            botRequest<DiscordGuild>(`/guilds/${guildId}`).catch(() => null)
        )
    },

    async getRoles(guildId: string): Promise<DiscordRole[]> {
        return cached(rolesKey(guildId), () =>
            botRequest<DiscordRole[]>(`/guilds/${guildId}/roles`).catch(() => [])
        )
    },

    async getChannels(guildId: string): Promise<DiscordChannel[]> {
        return cached(channelsKey(guildId), () =>
            botRequest<DiscordChannel[]>(`/guilds/${guildId}/channels`).catch(() => [])
        )
    },

    /** The bot's own member record, for the roles its permissions come from. */
    async getSelfMember(guildId: string): Promise<DiscordMember | null> {
        return cached(memberKey(guildId), () =>
            botRequest<DiscordMember>(`/guilds/${guildId}/members/${env.DISCORD_APP_ID}`).catch(() => null)
        )
    },

    async leaveGuild(guildId: string): Promise<boolean> {
        return botRequest<void>(`/users/@me/guilds/${guildId}`, { method: 'DELETE' })
            .then(() => true)
            .catch(() => false)
    },

    /**
     * Completes the install redirect.
     *
     * The authorization code is exchanged purely to confirm the install really
     * happened and to learn which guild it landed in — a `guild_id` query
     * parameter alone is attacker-supplied and would let someone bind a guild
     * they do not administer.
     */
    async exchangeInstall(code: string, redirectUri: string): Promise<DiscordGuild | null> {
        const body = new URLSearchParams({
            client_id: env.DISCORD_APP_ID,
            client_secret: env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        })

        const response = await fetch(`${API}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        }).catch(() => null)

        if (!response?.ok) return null

        const token = (await response.json().catch(() => null)) as { guild?: DiscordGuild } | null
        return token?.guild ?? null
    }
}

// --- Permission maths -------------------------------------------------------

/**
 * The bot's effective permissions in one channel.
 *
 * This is Discord's own algorithm and has to be reimplemented because the API
 * never reports it: base role permissions, then the @everyone overwrite, then
 * the union of role overwrites, then any member-specific overwrite. Getting
 * the order wrong reports a channel as writable that is not, which is exactly
 * the failure the dashboard exists to surface.
 */
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
