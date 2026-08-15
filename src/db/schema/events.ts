import { relations } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { visibilityEnum } from './enums'
import { groups } from './groups'
import { users } from './users'

/**
 * A shift is a recurring scheduled event. `rrule` drives recurrence,
 * `startTime` anchors the series and `duration` closes each occurrence out.
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
        color: text('color').notNull().default('#4287f5'),

        startTime: timestamp('start_time', { withTimezone: true }).notNull(),
        rrule: text('rrule').notNull(),
        /** Minutes. */
        duration: integer('duration').notNull().default(120),

        visibility: visibilityEnum('visibility').notNull().default('PUBLIC'),
        /** Minimum permission level required to host this shift. */
        hostLevel: integer('host_level').notNull().default(2),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        unique('events_group_slug_unique').on(table.groupId, table.slug),
        index('events_group_idx').on(table.groupId)
    ]
)

export const shiftSlots = pgTable(
    'shift_slots',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        eventId: uuid('event_id')
            .notNull()
            .references(() => events.eventId, { onDelete: 'cascade' }),

        name: text('name').notNull(),
        description: text('description').notNull().default(''),
        capacity: integer('capacity').notNull().default(1),
        order: integer('order').notNull().default(0)
    },
    (table) => [index('shift_slots_event_order_idx').on(table.eventId, table.order)]
)

/** One signup against one concrete occurrence of a recurring shift. */
export const shiftSignups = pgTable(
    'shift_signups',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        slotId: uuid('slot_id')
            .notNull()
            .references(() => shiftSlots.id, { onDelete: 'cascade' }),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),

        occurrence: timestamp('occurrence', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        unique('shift_signups_unique').on(table.slotId, table.occurrence, table.userId),
        index('shift_signups_occurrence_idx').on(table.occurrence)
    ]
)

export const eventsRelations = relations(events, ({ one, many }) => ({
    group: one(groups, { fields: [events.groupId], references: [groups.id] }),
    slots: many(shiftSlots)
}))

export const shiftSlotsRelations = relations(shiftSlots, ({ one, many }) => ({
    event: one(events, { fields: [shiftSlots.eventId], references: [events.eventId] }),
    signups: many(shiftSignups)
}))

export const shiftSignupsRelations = relations(shiftSignups, ({ one }) => ({
    slot: one(shiftSlots, { fields: [shiftSignups.slotId], references: [shiftSlots.id] }),
    user: one(users, { fields: [shiftSignups.userId], references: [users.id] })
}))

export type Event = typeof events.$inferSelect
export type ShiftSlot = typeof shiftSlots.$inferSelect
export type ShiftSignup = typeof shiftSignups.$inferSelect
