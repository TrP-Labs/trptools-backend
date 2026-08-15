import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { visibilityEnum } from './enums'
import { users } from './users'

/** Saved programs from the stage light programmer. */
export const stagePrograms = pgTable(
    'stage_programs',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        authorId: uuid('author_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),

        name: text('name').notNull(),
        soundId: text('sound_id'),
        /** JSON encoded `[[time, command, targets?], ...]`. */
        program: text('program').notNull(),

        visibility: visibilityEnum('visibility').notNull().default('PRIVATE'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [index('stage_programs_author_idx').on(table.authorId), index('stage_programs_visibility_idx').on(table.visibility)]
)

export const stageProgramsRelations = relations(stagePrograms, ({ one }) => ({
    author: one(users, { fields: [stagePrograms.authorId], references: [users.id] })
}))

export type StageProgram = typeof stagePrograms.$inferSelect
