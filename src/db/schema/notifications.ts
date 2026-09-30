import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import { groups } from './groups'
import { events } from './events'

export const pushSubscriptions = pgTable('push_subscriptions', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    endpointHash: text('endpoint_hash').notNull().unique(),
    subscription: text('subscription').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [index('push_subscriptions_user_idx').on(t.userId)])

export const notificationWatches = pgTable('notification_watches', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => events.eventId, { onDelete: 'cascade' })
}, (t) => [
    uniqueIndex('notification_watches_group_unique').on(t.userId, t.groupId).where(sql`${t.eventId} is null`),
    uniqueIndex('notification_watches_event_unique').on(t.userId, t.eventId).where(sql`${t.eventId} is not null`),
    index('notification_watches_group_idx').on(t.groupId)
])

export const notificationDeliveries = pgTable('notification_deliveries', {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id').notNull().references(() => pushSubscriptions.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull().references(() => events.eventId, { onDelete: 'cascade' }),
    occurrence: timestamp('occurrence', { withTimezone: true }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lease: uuid('lease'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true })
}, (t) => [
    uniqueIndex('notification_delivery_unique').on(t.subscriptionId, t.eventId, t.occurrence),
    index('notification_delivery_due_idx').on(t.availableAt).where(sql`${t.deliveredAt} is null AND ${t.attempts} < 5`)
])
