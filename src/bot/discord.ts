import { env } from '../utils/env'
import { dataRedis } from '../utils/redis'
import {
    channelPermissions,
    has,
    PERMISSIONS,
    POSTABLE_CHANNEL_TYPES,
    REQUIRED_PERMISSIONS,
    type DiscordChannel,
    type DiscordGuild,
    type DiscordMember,
    type DiscordRole,
    type PermissionName
} from './permissions'

export * from './permissions'

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
export const discordConfigured = Boolean(env.DISCORD_APP_ID && env.DISCORD_BOT_TOKEN)

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
