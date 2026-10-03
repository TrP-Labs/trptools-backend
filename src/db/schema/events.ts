import { relations } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { visibilityEnum } from './enums'
import { groups } from './groups'
import { translations } from './translations'

/**
 * A shift is a recurring scheduled event. `rrule` drives recurrence,
 * `startTime` anchors the series and `duration` closes each occurrence out.
 *
 * Staff slots belong to the group's sign-up sheets. Dated occurrences
 * snapshot this rule's content and on-demand settings in `shift_occurrences`.
 */
export const events = pgTable(
    'events',
    {
        eventId: uuid('event_id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        name: text('name').notNull(),
        /** Address of this shift's own page, unique within the group. */
        slug: text('slug').notNull(),
        description: text('description').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),
        color: text('color').notNull().default('#4287f5'),

        startTime: timestamp('start_time', { withTimezone: true }).notNull(),
        rrule: text('rrule').notNull(),
        /** Minutes. */
        duration: integer('duration').notNull().default(120),

        visibility: visibilityEnum('visibility').notNull().default('PUBLIC'),
        /** Minimum permission level required to host this shift. */
        hostLevel: integer('host_level').notNull().default(2),

        archived: boolean('archived').notNull().default(false),
        onDemand: boolean('on_demand').notNull().default(false),
        minimumVotes: integer('minimum_votes').notNull().default(10),
        voteLeadMinutes: integer('vote_lead_minutes').notNull().default(2880),
        decisionLeadMinutes: integer('decision_lead_minutes').notNull().default(1440),
        minimumRank: integer('minimum_rank').notNull().default(0),
        voteRequireDiscord: boolean('vote_require_discord').notNull().default(false),
        websiteVoting: boolean('website_voting').notNull().default(true),
        showVoters: boolean('show_voters').notNull().default(false),
        postDescription: text('post_description').notNull().default(''),
        publicStaff: boolean('public_staff').notNull().default(false),
        publicDrivers: boolean('public_drivers').notNull().default(false),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        notificationAt: timestamp('notification_at', { withTimezone: true }).defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        unique('events_group_slug_unique').on(table.groupId, table.slug),
        index('events_group_idx').on(table.groupId),
        index('events_notification_due_idx').on(table.notificationAt)
    ]
)

export const eventsRelations = relations(events, ({ one }) => ({
    group: one(groups, { fields: [events.groupId], references: [groups.id] })
}))

export type Event = typeof events.$inferSelect
