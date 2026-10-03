import { boolean, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { events } from './events'
import { groups } from './groups'
import { users } from './users'
import { visibilityEnum } from './enums'
import { translations } from './translations'

// Occurrences survive schedule edits and removal; their content and voting rules
// are snapshots, so changing next week's rule never rewrites last week's shift.
export const shiftOccurrences = pgTable('shift_occurrences', {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull().references(() => events.eventId, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    start: timestamp('start', { withTimezone: true }).notNull(),
    end: timestamp('end', { withTimezone: true }).notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color').notNull(),
    description: text('description').notNull().default(''),
    postDescription: text('post_description').notNull().default(''),
    translations: translations(),
    visibility: visibilityEnum('visibility').notNull().default('PUBLIC'),
    publicStaff: boolean('public_staff').notNull().default(false),
    publicDrivers: boolean('public_drivers').notNull().default(false),
    onDemand: boolean('on_demand').notNull().default(false),
    minimumVotes: integer('minimum_votes').notNull().default(10),
    voteOpensAt: timestamp('vote_opens_at', { withTimezone: true }).notNull(),
    decisionAt: timestamp('decision_at', { withTimezone: true }).notNull(),
    minimumRank: integer('minimum_rank').notNull().default(0),
    voteRequireDiscord: boolean('vote_require_discord').notNull().default(false),
    websiteVoting: boolean('website_voting').notNull().default(true),
    showVoters: boolean('show_voters').notNull().default(false),
    decision: text('decision').notNull().default('SCHEDULED'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [unique('shift_occurrences_event_start_unique').on(t.eventId, t.start), index('shift_occurrences_group_start_idx').on(t.groupId, t.start)])

export const shiftVotes = pgTable('shift_votes', {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id').notNull().references(() => shiftOccurrences.id, { onDelete: 'cascade' }),
    attending: boolean('attending').notNull().default(true),
    identity: text('identity').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    discordUserId: text('discord_user_id'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [unique('shift_votes_identity_unique').on(t.occurrenceId, t.identity)])

export const shiftDrivers = pgTable('shift_drivers', {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id').notNull().references(() => shiftOccurrences.id, { onDelete: 'cascade' }),
    robloxId: text('roblox_id').notNull(),
    name: text('name').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow()
}, t => [unique('shift_drivers_person_unique').on(t.occurrenceId, t.robloxId)])

// A ledger has no slot FK: deleting a sheet must not delete a past shift's staffing.
export const shiftStaffLog = pgTable('shift_staff_log', {
    signupId: uuid('signup_id').primaryKey(),
    eventId: uuid('event_id').notNull().references(() => events.eventId, { onDelete: 'cascade' }),
    occurrence: timestamp('occurrence', { withTimezone: true }).notNull(),
    name: text('name').notNull(),
    slot: text('slot').notNull(),
    status: text('status').notNull().default('SIGNED_UP'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [index('shift_staff_log_occurrence_idx').on(t.eventId, t.occurrence)])
