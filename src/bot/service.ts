import { status } from 'elysia'
import { eq, inArray } from 'drizzle-orm'
import db from '../db'
import { botConfigs, rankRelations, rankSignups, type BotConfig } from '../db/schema'
import { env, FRONTEND_URL } from '../utils/env'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { assertPermission } from '../utils/groupPermission'
import { dataRedis } from '../utils/redis'
import { generateSessionToken } from '../utils/sessionVerifier'
import type { session } from '../utils/sessionVerifier'
import { findGroup, recordAudit } from '../groups/service'
import { GroupModel } from '../groups/model'
import {
    CATEGORY_CHANNEL_TYPE,
    channelPermissions,
    Discord,
    discordConfigured,
    guildPermissions,
    has,
    invalidateGuild,
    INVITE_PERMISSIONS,
    POSTABLE_CHANNEL_TYPES,
    REQUIRED_PERMISSIONS,
    type PermissionName
} from './discord'
import { BotModel } from './model'

/** Wording for the dashboard's permission checklist. */
const PERMISSION_LABELS: Record<PermissionName, string> = {
    ADMINISTRATOR: 'Administrator',
    VIEW_CHANNEL: 'View channels',
    SEND_MESSAGES: 'Send messages',
    MANAGE_MESSAGES: 'Manage messages',
    EMBED_LINKS: 'Embed links',
    ATTACH_FILES: 'Attach files',
    READ_MESSAGE_HISTORY: 'Read message history',
    MENTION_EVERYONE: 'Mention roles',
    SEND_POLLS: 'Create polls'
}

const INSTALL_TTL = 600
const installKey = (state: string) => `bot:install:${state}`

const redirectUri = () => `${env.BASE_URL}/bot/callback`

function assertAvailable() {
    if (!discordConfigured) {
        throw status(503, 'Discord is not configured on this instance' satisfies BotModel.unavailable)
    }
}

function presentConfig(row: BotConfig): BotModel.config {
    return {
        groupId: row.groupId,
        guildId: row.guildId,
        installedAt: row.installedAt,

        announcementChannel: row.announcementChannel,
        pollChannel: row.pollChannel,
        hostChannel: row.hostChannel,

        shiftPingRole: row.shiftPingRole,
        hostPingRole: row.hostPingRole,

        placeId: row.placeId,
        ownerRobloxId: row.ownerRobloxId,

        announcementsEnabled: row.announcementsEnabled,
        signupsEnabled: row.signupsEnabled,
        pollsEnabled: row.pollsEnabled,
        remindersEnabled: row.remindersEnabled,
        manifestEnabled: row.manifestEnabled,

        autoAnnounce: row.autoAnnounce,
        autoAnnounceLead: row.autoAnnounceLead,
        autoSignups: row.autoSignups,
        autoSignupsLead: row.autoSignupsLead,
        autoHostReminder: row.autoHostReminder,
        autoHostReminderLead: row.autoHostReminderLead,
        autoBegin: row.autoBegin,
        autoBeginLead: row.autoBeginLead,
        autoComplete: row.autoComplete,
        autoCompleteDelay: row.autoCompleteDelay,

        manifestRefreshSeconds: row.manifestRefreshSeconds
    }
}

/** The bot's live standing in a guild, as the dashboard header reports it. */
async function guildStatus(guildId: string): Promise<BotModel.guildStatus> {
    const [guild, roles, member] = await Promise.all([
        Discord.getGuild(guildId),
        Discord.getRoles(guildId),
        Discord.getSelfMember(guildId)
    ])

    // Discord answers 404 for a guild the bot is not in, so a missing member
    // record is the signal that it was removed rather than a transient error.
    const present = Boolean(guild && member)

    const permissions = present ? guildPermissions(roles, member!.roles, guildId) : 0n

    const checklist = REQUIRED_PERMISSIONS.map((name) => ({
        name,
        label: PERMISSION_LABELS[name],
        granted: present && has(permissions, name)
    }))

    return {
        guildId,
        name: guild?.name ?? null,
        icon: guild?.icon ? `https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.png?size=128` : null,
        present,
        permissions: checklist,
        healthy: checklist.every((entry) => entry.granted)
    }
}

async function requireConfig(groupIdOrSlug: string, session: session, level = PERMISSION.MANAGE) {
    const group = await findGroup(groupIdOrSlug)
    if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

    await assertPermission(session, group.id, level)

    const [config] = await db.select().from(botConfigs).where(eq(botConfigs.groupId, group.id)).limit(1)
    if (!config) throw status(404, 'no bot is connected to this group' satisfies BotModel.notConnected)

    return { group, config }
}

export abstract class Bot {
    /**
     * Begins the "add to a server" flow.
     *
     * The group and the person who asked are parked in Redis under a random
     * state value rather than travelling in the URL, so the callback cannot be
     * pointed at a group the caller does not manage.
     */
    static async beginInstall(groupIdOrSlug: string, session: session): Promise<BotModel.installResponse> {
        assertAvailable()

        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const state = generateSessionToken()
        await dataRedis.set(
            installKey(state),
            JSON.stringify({ groupId: group.id, userId: session.user?.userId ?? null }),
            'EX',
            INSTALL_TTL
        )

        const url = new URL('https://discord.com/oauth2/authorize')
        url.searchParams.set('client_id', env.DISCORD_APP_ID)
        url.searchParams.set('scope', 'bot applications.commands')
        url.searchParams.set('permissions', INVITE_PERMISSIONS.toString())
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('redirect_uri', redirectUri())
        url.searchParams.set('state', state)

        return { url: url.toString() }
    }

    /**
     * Finishes the install redirect and lands the browser back on the bot page.
     *
     * This is a top-level navigation, so every outcome has to end at a page
     * that explains itself rather than at a JSON error.
     */
    static async completeInstall(query: BotModel.callbackQuery): Promise<string> {
        const fail = (reason: string) => `${FRONTEND_URL}/dashboard?botError=${reason}`

        if (!discordConfigured) return fail('unavailable')
        if (query.error || !query.code || !query.state) return fail('cancelled')

        const raw = await dataRedis.get(installKey(query.state)).catch(() => null)
        if (!raw) return fail('expired')
        await dataRedis.del(installKey(query.state)).catch(() => undefined)

        const { groupId, userId } = JSON.parse(raw) as { groupId: string; userId: string | null }

        const group = await findGroup(groupId)
        if (!group) return fail('unknown-group')

        const guild = await Discord.exchangeInstall(query.code, redirectUri())
        if (!guild) return fail('exchange-failed')

        // One guild cannot serve two groups: the bot resolves a slash command
        // to a group by its guild id, and a shared guild would be ambiguous.
        const [claimed] = await db.select().from(botConfigs).where(eq(botConfigs.guildId, guild.id)).limit(1)
        if (claimed && claimed.groupId !== group.id) {
            return `${FRONTEND_URL}/dashboard/${group.slug}/bot?botError=guild-taken`
        }

        await db
            .insert(botConfigs)
            .values({
                groupId: group.id,
                guildId: guild.id,
                cachedGuildName: guild.name,
                cachedGuildIcon: guild.icon,
                cachedAt: new Date(),
                installedBy: userId
            })
            .onConflictDoUpdate({
                target: botConfigs.groupId,
                set: {
                    guildId: guild.id,
                    cachedGuildName: guild.name,
                    cachedGuildIcon: guild.icon,
                    cachedAt: new Date(),
                    installedBy: userId
                }
            })

        await invalidateGuild(guild.id)
        await recordAudit(group.id, userId, 'bot.install', `Connected the Discord server ${guild.name}`)

        return `${FRONTEND_URL}/dashboard/${group.slug}/bot?installed=1`
    }

    /** The bot page in one read: configuration plus live guild health. */
    static async overview(groupIdOrSlug: string, session: session): Promise<BotModel.overview> {
        const group = await findGroup(groupIdOrSlug)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const [config] = await db.select().from(botConfigs).where(eq(botConfigs.groupId, group.id)).limit(1)

        if (!config) {
            return { connected: false, available: discordConfigured, config: null, guild: null }
        }

        return {
            connected: true,
            available: discordConfigured,
            config: presentConfig(config),
            guild: await guildStatus(config.guildId)
        }
    }

    static async update(
        groupIdOrSlug: string,
        body: BotModel.updateBody,
        session: session
    ): Promise<BotModel.config> {
        const { group, config } = await requireConfig(groupIdOrSlug, session)

        if (Object.keys(body).length > 0) {
            await db.update(botConfigs).set(body).where(eq(botConfigs.id, config.id))
        }

        await recordAudit(group.id, session.user?.userId ?? null, 'bot.update', 'Updated bot settings')

        const [updated] = await db.select().from(botConfigs).where(eq(botConfigs.id, config.id)).limit(1)
        if (!updated) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        return presentConfig(updated)
    }

    /**
     * Disconnects a guild and has the bot leave it.
     *
     * Leaving is attempted but not required to succeed — if Discord refuses,
     * the binding still goes, because the alternative is a group stuck with a
     * bot it cannot reconfigure.
     */
    static async remove(groupIdOrSlug: string, session: session) {
        const { group, config } = await requireConfig(groupIdOrSlug, session)

        await Discord.leaveGuild(config.guildId)
        await invalidateGuild(config.guildId)

        await db.delete(botConfigs).where(eq(botConfigs.id, config.id))

        // Per-rank Discord bindings name channels in the guild that just went
        // away. Left in place they would point at another server's ids after a
        // reinstall elsewhere, so they are cleared with the rest of the
        // configuration rather than left to fail quietly.
        const ranks = await db
            .select({ id: rankRelations.id })
            .from(rankRelations)
            .where(eq(rankRelations.groupId, group.id))

        if (ranks.length > 0) {
            await db
                .update(rankSignups)
                .set({ discordChannel: null, discordPingRole: null })
                .where(
                    inArray(
                        rankSignups.rankId,
                        ranks.map((rank) => rank.id)
                    )
                )
        }

        await recordAudit(group.id, session.user?.userId ?? null, 'bot.remove', 'Disconnected the Discord server')

        return 'Success' as globalModel.genericSuccess
    }

    /**
     * Every channel the bot could post in, each annotated with whether it
     * actually can.
     *
     * The read/send flags are the point: a picker that lists a channel the bot
     * cannot see is how a group ends up with announcements silently going
     * nowhere.
     */
    static async channels(
        groupIdOrSlug: string,
        session: session,
        refresh = false
    ): Promise<BotModel.channelList> {
        const { config } = await requireConfig(groupIdOrSlug, session)
        if (refresh) await invalidateGuild(config.guildId)

        const [channels, roles, member] = await Promise.all([
            Discord.getChannels(config.guildId),
            Discord.getRoles(config.guildId),
            Discord.getSelfMember(config.guildId)
        ])

        const categories = new Map(
            channels
                .filter((channel) => channel.type === CATEGORY_CHANNEL_TYPE)
                .map((channel) => [channel.id, channel.name ?? ''])
        )

        return channels
            .filter((channel) => POSTABLE_CHANNEL_TYPES.has(channel.type))
            .map((channel) => {
                const permissions = member
                    ? channelPermissions(channel, roles, member.roles, config.guildId, env.DISCORD_APP_ID)
                    : 0n

                return {
                    id: channel.id,
                    name: channel.name ?? 'unnamed',
                    type: channel.type,
                    parentId: channel.parent_id ?? null,
                    parentName: channel.parent_id ? (categories.get(channel.parent_id) ?? null) : null,
                    position: channel.position ?? 0,
                    canRead: has(permissions, 'VIEW_CHANNEL'),
                    // Posting an announcement means an embed, and often an
                    // image, so all three are what "can send" has to mean.
                    canSend:
                        has(permissions, 'VIEW_CHANNEL') &&
                        has(permissions, 'SEND_MESSAGES') &&
                        has(permissions, 'EMBED_LINKS')
                }
            })
            .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    }

    static async roles(groupIdOrSlug: string, session: session, refresh = false): Promise<BotModel.roleList> {
        const { config } = await requireConfig(groupIdOrSlug, session)
        if (refresh) await invalidateGuild(config.guildId)

        const [roles, member] = await Promise.all([
            Discord.getRoles(config.guildId),
            Discord.getSelfMember(config.guildId)
        ])

        const permissions = member ? guildPermissions(roles, member.roles, config.guildId) : 0n
        const canMentionAnything = has(permissions, 'MENTION_EVERYONE')

        // A role above the bot's own highest role cannot be mentioned by it
        // unless it holds Mention Everyone, so the picker has to know where
        // the bot sits in the hierarchy.
        const botTop = member
            ? Math.max(
                  0,
                  ...roles.filter((role) => member.roles.includes(role.id)).map((role) => role.position)
              )
            : 0

        return roles
            .filter((role) => role.id !== config.guildId)
            .map((role) => ({
                id: role.id,
                name: role.name,
                color: role.color === 0 ? '#99aab5' : `#${role.color.toString(16).padStart(6, '0')}`,
                position: role.position,
                canMention: canMentionAnything || (role.mentionable && role.position < botTop),
                managed: role.managed,
                memberCount: null
            }))
            .sort((a, b) => b.position - a.position)
    }
}
