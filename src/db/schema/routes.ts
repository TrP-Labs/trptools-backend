import { relations } from 'drizzle-orm'
import {
    boolean,
    doublePrecision,
    index,
    integer,
    pgTable,
    primaryKey,
    text,
    timestamp,
    unique,
    uuid
} from 'drizzle-orm/pg-core'
import { moderationEnum, routePreferenceEnum, routeShapeEnum, visibilityEnum } from './enums'
import { groups } from './groups'
import { users } from './users'

/**
 * A depot is a spawn location in game, identified by its number.
 *
 * Routes declare which depots they can be dispatched from, which is what lets
 * automatic assignment work for custom routes instead of only the handful the
 * legacy tool hardcoded.
 */
export const depots = pgTable(
    'depots',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        /** The number the game uses to identify this depot. */
        number: integer('number').notNull(),
        name: text('name').notNull(),
        /** Address of this depot's own page, unique within the group. */
        slug: text('slug').notNull(),
        description: text('description').notNull().default(''),
        color: text('color').notNull().default('#4287f5'),

        /**
         * Extra spellings the game may report for this depot.
         *
         * The game sends a spawn name like "Main Island Depot" while groups
         * name their depot "Main Island", and a depot that was renamed in game
         * keeps answering to its old name for a while. Matching normalises
         * both sides, and anything that still fails goes here by hand.
         */
        aliases: text('aliases').array().notNull().default([]),

        /** An uploaded image shown in place of the depot number. */
        iconMediaId: uuid('icon_media_id'),

        visibility: visibilityEnum('visibility').notNull().default('PUBLIC'),
        moderation: moderationEnum('moderation').notNull().default('VISIBLE'),

        /**
         * Whether this depot is listed on the group's public page.
         *
         * Separate from visibility on purpose: a depot can stay readable at its
         * own address, and to members, while a group keeps the page itself to a
         * short list rather than every depot it has ever opened.
         */
        showOnGroupPage: boolean('show_on_group_page').notNull().default(true),

        order: integer('order').notNull().default(0),
        archived: boolean('archived').notNull().default(false),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        unique('depots_group_number_unique').on(table.groupId, table.number),
        unique('depots_group_slug_unique').on(table.groupId, table.slug),
        index('depots_group_idx').on(table.groupId)
    ]
)

export const routes = pgTable(
    'routes',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        name: text('name').notNull(),
        /** Address of this route's own page, unique within the group. */
        slug: text('slug').notNull(),
        description: text('description').notNull().default(''),

        // Presentation — this is what the legacy tool could never do for
        // custom routes.
        color: text('color').notNull().default('#4287f5'),
        textColor: text('text_color').notNull().default('#111111'),
        shape: routeShapeEnum('shape').notNull().default('AUTO'),

        /** An uploaded badge shown instead of the coloured roundel. */
        iconMediaId: uuid('icon_media_id'),

        /**
         * The share of dispatchable vehicles this route should carry, as a
         * percentage. Shares are normalised across whichever routes a vehicle's
         * depot actually serves, so they do not have to add up to 100.
         *
         * Fractional, because a share is a ratio rather than a count — three
         * routes splitting a depot evenly is 33.33 each, which whole numbers
         * could only approximate.
         */
        targetShare: doublePrecision('target_share').notNull().default(20),

        autoAssign: boolean('auto_assign').notNull().default(true),
        order: integer('order').notNull().default(0),
        archived: boolean('archived').notNull().default(false),

        /**
         * The routes that ship with the game. Every group gets them, and they
         * can be disabled but never deleted — a group that removed one could
         * not get it back without support.
         */
        builtIn: boolean('built_in').notNull().default(false),

        visibility: visibilityEnum('visibility').notNull().default('PUBLIC'),
        moderation: moderationEnum('moderation').notNull().default('VISIBLE'),

        /**
         * Whether this route is listed on the group's public page.
         *
         * Separate from visibility: the route keeps its own page and stays
         * readable, it simply does not crowd the group's front page. The
         * built-in routes are seeded with this off, since a group's page is
         * meant to show what makes that group different.
         */
        showOnGroupPage: boolean('show_on_group_page').notNull().default(true),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        unique('routes_group_name_unique').on(table.groupId, table.name),
        unique('routes_group_slug_unique').on(table.groupId, table.slug),
        index('routes_group_archived_idx').on(table.groupId, table.archived)
    ]
)

/** Which depots a route can be dispatched from. Empty means every depot. */
export const routeDepots = pgTable(
    'route_depots',
    {
        routeId: uuid('route_id')
            .notNull()
            .references(() => routes.id, { onDelete: 'cascade' }),
        depotId: uuid('depot_id')
            .notNull()
            .references(() => depots.id, { onDelete: 'cascade' })
    },
    (table) => [primaryKey({ columns: [table.routeId, table.depotId] })]
)

/** Drivers can mark routes they want, and routes they would rather avoid. */
export const routePreferences = pgTable(
    'route_preferences',
    {
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        routeId: uuid('route_id')
            .notNull()
            .references(() => routes.id, { onDelete: 'cascade' }),
        preference: routePreferenceEnum('preference').notNull()
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.routeId] }),
        index('route_preferences_route_idx').on(table.routeId)
    ]
)

export const depotsRelations = relations(depots, ({ one, many }) => ({
    group: one(groups, { fields: [depots.groupId], references: [groups.id] }),
    routeDepots: many(routeDepots)
}))

export const routesRelations = relations(routes, ({ one, many }) => ({
    group: one(groups, { fields: [routes.groupId], references: [groups.id] }),
    routeDepots: many(routeDepots),
    preferences: many(routePreferences)
}))

export const routeDepotsRelations = relations(routeDepots, ({ one }) => ({
    route: one(routes, { fields: [routeDepots.routeId], references: [routes.id] }),
    depot: one(depots, { fields: [routeDepots.depotId], references: [depots.id] })
}))

export const routePreferencesRelations = relations(routePreferences, ({ one }) => ({
    user: one(users, { fields: [routePreferences.userId], references: [users.id] }),
    route: one(routes, { fields: [routePreferences.routeId], references: [routes.id] })
}))

export type Route = typeof routes.$inferSelect
export type Depot = typeof depots.$inferSelect
export type RoutePreference = typeof routePreferences.$inferSelect
