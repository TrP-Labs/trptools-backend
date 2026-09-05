import { relations, sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { applicationQuestionEnum, applicationStatusEnum } from './enums'
import { groups, rankRelations } from './groups'
import { users } from './users'
import { translations } from './translations'

/**
 * A staff application form.
 *
 * An application is always **for a rank**: it is how somebody asks to be given
 * one, so the rank binding is what says what is being applied for and who the
 * decision is about. A form with no rank bound cannot be opened — there would
 * be no answer to "approved for what".
 *
 * `open` gates submission only. Closing a form deliberately keeps everything
 * already submitted: a group that stops taking applicants still has a pile of
 * them to work through, and a close that discarded them would make closing the
 * form the most destructive button on the page.
 */
export const applications = pgTable(
    'applications',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        /**
         * The rank this form applies for.
         *
         * Nullable, and set null rather than cascading when the binding goes:
         * unbinding a rank should not take a form and its applicants with it.
         * A form in that state simply stops being open.
         */
        rankId: uuid('rank_id').references(() => rankRelations.id, { onDelete: 'set null' }),

        name: text('name').notNull(),
        /** Address of this form's public page, unique within the group. */
        slug: text('slug').notNull(),
        description: text('description').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),
        color: text('color').notNull().default('#4287f5'),

        /** Whether new submissions are accepted. Never affects existing ones. */
        open: boolean('open').notNull().default(false),

        /**
         * When this form was last opened, which is what makes a decision
         * expire.
         *
         * A refusal is about an intake, not about a person: closing the form
         * ends the round, and reopening it invites everybody to try again.
         * Comparing a decision against this is how somebody turned down in
         * March is free to apply when applications reopen in June, without a
         * group having to go through the archive clearing records by hand.
         *
         * Only set when `open` actually flips on, never on a patch that leaves
         * an open form open — otherwise saving any other setting would quietly
         * release everybody who had been refused.
         */
        openedAt: timestamp('opened_at', { withTimezone: true }),

        /**
         * Whether a refusal outlives the intake it was made in.
         *
         * Off by default, which is the rule above. Turned on, a denied
         * applicant stays denied through every reopening until an admin clears
         * their record — for the person a group does not want to see again
         * rather than the one who applied too early. An approval is never
         * permanent this way: somebody who got the rank and later lost it is
         * exactly who should be able to apply again.
         */
        permaDeny: boolean('perma_deny').notNull().default(false),

        /**
         * How many days a refusal keeps somebody out, when it is not permanent.
         *
         * Null means "until applications close and reopen", which is the
         * default rule. A group that keeps one form open all year has no
         * closing moment to release people at, so this says how long a refusal
         * is meant to last instead. Ignored while `permaDeny` is on, where not
         * lapsing is the whole point.
         */
        denyCooldownDays: integer('deny_cooldown_days'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        unique('applications_group_slug_unique').on(table.groupId, table.slug),
        index('applications_group_idx').on(table.groupId)
    ]
)

/**
 * One component of a form, in `order`.
 *
 * Not every component asks a question. `SECTION` and `IMAGE` are there to be
 * read — a heading, an explanation, a picture of the thing being applied for —
 * and collect no answer. They live in the same table and the same ordering
 * because a group building a form is arranging one list, not two, and pulling
 * the static ones into their own table would mean two orderings that could
 * disagree about what comes after what.
 */
export const applicationQuestions = pgTable(
    'application_questions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        applicationId: uuid('application_id')
            .notNull()
            .references(() => applications.id, { onDelete: 'cascade' }),

        type: applicationQuestionEnum('type').notNull().default('SHORT_TEXT'),

        /** The question itself, or the heading for a section. */
        prompt: text('prompt').notNull().default(''),
        /** Smaller text under the prompt: guidance, or the body of a section. */
        description: text('description').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),

        required: boolean('required').notNull().default(false),
        order: integer('order').notNull().default(0),

        /** Choices, for the two picking types. Empty for everything else. */
        options: text('options').array().notNull().default([]),

        /** How long an answer may be, for the two text types. */
        maxLength: integer('max_length'),

        /** The uploaded image an `IMAGE` component shows. */
        mediaId: uuid('media_id')
    },
    (table) => [index('application_questions_order_idx').on(table.applicationId, table.order)]
)

/**
 * One person's application, and what was decided about it.
 *
 * A decision archives rather than deletes: `APPROVED` and `DENIED` rows stay
 * exactly where they are and are simply read from a different list, so a group
 * can go back to what somebody wrote and to who decided it.
 */
export const applicationSubmissions = pgTable(
    'application_submissions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        applicationId: uuid('application_id')
            .notNull()
            .references(() => applications.id, { onDelete: 'cascade' }),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),

        status: applicationStatusEnum('status').notNull().default('PENDING'),

        submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
        reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
        reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
        /** What the reviewer wrote, shown back to the applicant. */
        reviewNote: text('review_note').notNull().default(''),

        /**
         * When an admin let this decision stop counting against the applicant.
         *
         * Separate from deleting the row, and that is the point: clearing
         * keeps what somebody wrote and who decided it while letting them
         * apply again, so a group can undo a lock-out without also destroying
         * the record of why it was there.
         */
        clearedAt: timestamp('cleared_at', { withTimezone: true }),

        /**
         * Where the applicant is, as they had it when they applied.
         *
         * Snapshotted rather than read off their account at review time: a
         * reviewer deciding whether somebody covers the evening service is
         * reading what was true when they offered, and an account preference
         * changed since would silently rewrite the answer.
         */
        timezone: text('timezone').notNull().default('UTC'),
        locale: text('locale').notNull().default('en')
    },
    (table) => [
        // Partial rather than a plain unique: somebody may only have one
        // application waiting at a time, but a decided one is history and must
        // not stop them applying again where the group allows it.
        uniqueIndex('application_submissions_pending_unique')
            .on(table.applicationId, table.userId)
            .where(sql`${table.status} = 'PENDING'`),
        index('application_submissions_review_idx').on(table.applicationId, table.status, table.submittedAt)
    ]
)

/**
 * One answer, carrying its own copy of the question it answered.
 *
 * The prompt is snapshotted because the form keeps being edited after people
 * apply. Reading an archived application through today's questions would
 * silently re-label what somebody wrote — and a question deleted since would
 * leave the answer with nothing to say it was ever asked.
 */
export const applicationAnswers = pgTable(
    'application_answers',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        submissionId: uuid('submission_id')
            .notNull()
            .references(() => applicationSubmissions.id, { onDelete: 'cascade' }),
        /** Null once the question it answered has been deleted. */
        questionId: uuid('question_id').references(() => applicationQuestions.id, { onDelete: 'set null' }),

        prompt: text('prompt').notNull().default(''),
        type: applicationQuestionEnum('type').notNull().default('SHORT_TEXT'),
        order: integer('order').notNull().default(0),

        /** Text answers. Empty for the picking types. */
        value: text('value').notNull().default(''),
        /** Picked choices. Empty for the text types. */
        choices: text('choices').array().notNull().default([])
    },
    (table) => [index('application_answers_submission_idx').on(table.submissionId, table.order)]
)

export const applicationsRelations = relations(applications, ({ one, many }) => ({
    group: one(groups, { fields: [applications.groupId], references: [groups.id] }),
    rank: one(rankRelations, { fields: [applications.rankId], references: [rankRelations.id] }),
    questions: many(applicationQuestions),
    submissions: many(applicationSubmissions)
}))

export const applicationQuestionsRelations = relations(applicationQuestions, ({ one }) => ({
    application: one(applications, {
        fields: [applicationQuestions.applicationId],
        references: [applications.id]
    })
}))

export const applicationSubmissionsRelations = relations(applicationSubmissions, ({ one, many }) => ({
    application: one(applications, {
        fields: [applicationSubmissions.applicationId],
        references: [applications.id]
    }),
    user: one(users, { fields: [applicationSubmissions.userId], references: [users.id] }),
    answers: many(applicationAnswers)
}))

export const applicationAnswersRelations = relations(applicationAnswers, ({ one }) => ({
    submission: one(applicationSubmissions, {
        fields: [applicationAnswers.submissionId],
        references: [applicationSubmissions.id]
    })
}))

export type Application = typeof applications.$inferSelect
export type ApplicationQuestion = typeof applicationQuestions.$inferSelect
export type ApplicationSubmission = typeof applicationSubmissions.$inferSelect
export type ApplicationAnswer = typeof applicationAnswers.$inferSelect
