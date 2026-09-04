import { relations } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { moderationEnum, visibilityEnum, vehicleCategoryEnum } from './enums'
import { routes, depots } from './routes'
import { events } from './events'
import { botConfigs } from './bot'
import { rankSignups } from './signups'
import { translations } from './translations'

export const groups = pgTable(
    'groups',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        robloxId: text('roblox_id').notNull().unique(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

        // Public presence
        slug: text('slug').notNull().unique(),
        visibility: visibilityEnum('visibility').notNull().default('PRIVATE'),
        /**
         * What the group calls itself here, when that differs from Roblox.
         *
         * Null means "whatever Roblox says", which is what a group gets on
         * registration and keeps unless somebody types over it — so a rename
         * on Roblox still follows through on its own. Copying the Roblox name
         * into this column at registration would have frozen it at that
         * moment for every group that never opened settings. Clearing the box
         * puts it back to following.
         */
        name: text('name'),
        tagline: text('tagline').notNull().default(''),
        about: text('about').notNull().default(''),
        /** Per-language versions of the three fields above. See `./translations.ts`. */
        translations: translations(),

        /**
         * The language this group writes in.
         *
         * Every name, description and question a group types is in *some*
         * language, and it is not safely English: TrP has groups that run in
         * Ukrainian and would have had their own words labelled as the English
         * original. It is set on registration from the manager's own account
         * language, falling back to what their browser asked for, and is the
         * language a reader falls back to when there is no version in theirs.
         */
        sourceLocale: text('source_locale').notNull().default('en'),
        accentColor: text('accent_color').notNull().default('#4287f5'),
        /** Public URL of the current banner, denormalised so page reads stay one query. */
        bannerImage: text('banner_image'),
        /** The media row behind `bannerImage`, so replacing one cleans up the object. */
        bannerMediaId: uuid('banner_media_id'),

        /**
         * How long before a shift starts its dispatch room may be opened.
         *
         * Hosts want to set the room up before people arrive, but a room
         * opened hours early holds the group's single room slot for no reason,
         * so the window is the group's to choose.
         */
        roomOpenLeadMinutes: integer('room_open_lead_minutes').notNull().default(10),

        /**
         * How long before a shift its sign-up sheets open.
         *
         * Sheets sat on every occurrence in the schedule, months out, which
         * made the shift page a wall of empty forms and let people commit to a
         * shift nobody had planned yet. They now appear this far ahead and
         * close when the shift ends.
         */
        signupLeadMinutes: integer('signup_lead_minutes').notNull().default(1440),

        // Which parts of the public page are exposed
        showRoutes: boolean('show_routes').notNull().default(true),
        showShifts: boolean('show_shifts').notNull().default(true),
        showRoster: boolean('show_roster').notNull().default(false),
        showDispatch: boolean('show_dispatch').notNull().default(false),

        /**
         * An Open Cloud API key scoped to `group:read`, encrypted at rest.
         *
         * Open Cloud v2 rejects anonymous reads, and a user's own OAuth token
         * is capped at 30-90 requests/minute — far too low for permission
         * checks on every request. A group-owned key raises that to 300/minute
         * and keeps working when nobody is signed in.
         */
        openCloudKey: text('open_cloud_key'),

        // Cached Roblox group data
        cachedName: text('cached_name'),
        cachedDescription: text('cached_description'),
        cachedIcon: text('cached_icon'),
        cachedMembers: integer('cached_members'),
        cachedAt: timestamp('cached_at', { withTimezone: true }),

        /** Set to HIDDEN by a report, and to APPROVED once an admin clears it. */
        moderation: moderationEnum('moderation').notNull().default('VISIBLE')
    },
    (table) => [index('groups_visibility_idx').on(table.visibility)]
)

export const rankRelations = pgTable(
    'rank_relations',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        robloxId: text('roblox_id').notNull(),

        color: text('color').notNull().default('#9b59b6'),

        /** Shown alongside the rank on the group's public roster. */
        description: text('description').notNull().default(''),
        /** Whether this rank and its holders appear on the public roster. */
        visible: boolean('visible').notNull().default(false),

        cachedName: text('cached_name').notNull(),
        cachedRank: integer('cached_rank').notNull(),

        // 0 = none, 1 = dispatch, 2 = host, 3 = manage
        permissionLevel: integer('permission_level').notNull().default(0),

        maxActivity: integer('max_activity'),
        minActivity: integer('min_activity')
    },
    (table) => [
        unique('rank_relations_group_role_unique').on(table.groupId, table.robloxId),
        index('rank_relations_roblox_idx').on(table.robloxId)
    ]
)

export const auditMessages = pgTable(
    'audit_messages',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        action: text('action').notNull(),
        summary: text('summary').notNull(),
        actorId: uuid('actor_id'),
        date: timestamp('date', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [index('audit_group_date_idx').on(table.groupId, table.date)]
)

/**
 * Replaces the hardcoded vehicle name overrides from the legacy dispatcher.
 * Rules are evaluated in `order`; the first match wins.
 */
export const vehicleRules = pgTable(
    'vehicle_rules',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        pattern: text('pattern').notNull(),
        category: vehicleCategoryEnum('category').notNull().default('OTHER'),
        // A literal label pinned onto matching vehicles instead of a real route.
        fixedRoute: text('fixed_route'),
        order: integer('order').notNull().default(0)
    },
    (table) => [index('vehicle_rules_group_order_idx').on(table.groupId, table.order)]
)

export const groupsRelations = relations(groups, ({ many, one }) => ({
    ranks: many(rankRelations),
    audit: many(auditMessages),
    routes: many(routes),
    depots: many(depots),
    events: many(events),
    vehicleRules: many(vehicleRules),
    bot: one(botConfigs)
}))

export const rankRelationsRelations = relations(rankRelations, ({ one }) => ({
    group: one(groups, { fields: [rankRelations.groupId], references: [groups.id] }),
    signup: one(rankSignups)
}))

export const auditMessagesRelations = relations(auditMessages, ({ one }) => ({
    group: one(groups, { fields: [auditMessages.groupId], references: [groups.id] })
}))

export const vehicleRulesRelations = relations(vehicleRules, ({ one }) => ({
    group: one(groups, { fields: [vehicleRules.groupId], references: [groups.id] })
}))

export type Group = typeof groups.$inferSelect
export type RankRelation = typeof rankRelations.$inferSelect
export type VehicleRule = typeof vehicleRules.$inferSelect
export type AuditMessage = typeof auditMessages.$inferSelect
