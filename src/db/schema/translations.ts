import { jsonb } from 'drizzle-orm/pg-core'

/**
 * A group's own words, in the languages it wrote them in.
 *
 * A route's name, a depot's description, the prompt on an application
 * question — everything a group types that somebody else reads. One of those
 * strings is written in the group's *source* language (`groups.sourceLocale`,
 * whatever its manager was using when they registered), and a manager may add
 * a version of it in any language the site ships.
 *
 * Shaped `{ field: { locale: text } }` and stored on the row itself rather
 * than in a table of its own. A side table would have to be polymorphic —
 * there is no one entity these hang off — which means no foreign key, which
 * means every delete path in the codebase becomes responsible for not leaving
 * orphans behind. Here a translation is deleted with the thing it translates,
 * saved in the same statement that saves the source text, and read in the same
 * query. Nothing filters or sorts by a translation, which is the only thing a
 * side table would have bought.
 *
 * Fields absent from the object are simply untranslated: the reader falls back
 * to the source text. That is also what an empty string means, so clearing a
 * box removes the translation rather than publishing a blank name.
 */
export type Translations = Record<string, Record<string, string>>

/** The column, identical everywhere it appears. */
export const translations = () => jsonb('translations').$type<Translations>().notNull().default({})
