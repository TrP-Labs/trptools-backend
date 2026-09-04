import { relations } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { mediaOwnerEnum, moderationEnum } from './enums'
import { groups } from './groups'
import { users } from './users'
import { translations } from './translations'

/**
 * An uploaded image, stored in S3-compatible object storage.
 *
 * Rows are always scoped to a group even when they hang off a route or depot,
 * so moderation and cleanup can work group-at-a-time without walking every
 * owner type.
 */
export const media = pgTable(
    'media',
    {
        id: uuid('id').primaryKey().defaultRandom(),

        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),

        ownerType: mediaOwnerEnum('owner_type').notNull(),
        /** The route or depot this belongs to; null when it belongs to the group. */
        ownerId: uuid('owner_id'),

        /** Object key in the bucket. The public URL is derived from it. */
        key: text('key').notNull().unique(),
        contentType: text('content_type').notNull(),
        size: integer('size').notNull(),
        caption: text('caption').notNull().default(''),
        /** Per-language versions of the text above. See `./translations.ts`. */
        translations: translations(),
        order: integer('order').notNull().default(0),

        moderation: moderationEnum('moderation').notNull().default('VISIBLE'),

        uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
    },
    (table) => [
        index('media_owner_idx').on(table.ownerType, table.ownerId),
        index('media_group_idx').on(table.groupId)
    ]
)

export const mediaRelations = relations(media, ({ one }) => ({
    group: one(groups, { fields: [media.groupId], references: [groups.id] }),
    uploader: one(users, { fields: [media.uploadedBy], references: [users.id] })
}))

export type Media = typeof media.$inferSelect
