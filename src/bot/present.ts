import type { BotConfig } from '../db/schema'
import type { BotModel } from './model'

/**
 * The stored bot configuration as both the dashboard and the bot process read
 * it. Shared so the two can never disagree about what a setting is called.
 */
export function presentConfig(row: BotConfig): BotModel.config {
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
        autoStaffStart: row.autoStaffStart,
        autoStaffStartLead: row.autoStaffStartLead,
        autoBegin: row.autoBegin,
        autoBeginLead: row.autoBeginLead,
        autoComplete: row.autoComplete,
        autoCompleteDelay: row.autoCompleteDelay,

        manifestRefreshSeconds: row.manifestRefreshSeconds
    }
}
