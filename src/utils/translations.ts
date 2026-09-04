import { t } from 'elysia'
import type { Translations } from '../db/schema/translations'
import { isSupportedLocale } from './locales'

/**
 * What a group is allowed to translate, and how a patch is applied.
 *
 * The shape (`{ field: { locale: text } }`) and the reasoning for storing it
 * on the row are in `db/schema/translations.ts`. This is the half that decides
 * which fields are real and refuses anything else — the column is JSON, so
 * without a list here a caller could write whatever keys it liked into it and
 * they would be handed back to every reader.
 *
 * A field is named after the column it stands in for, so `route.name` is
 * translated under `name`. That is deliberate: a presenter can ask for the
 * translation of the field it is about to send without a second mapping to
 * keep in step.
 */
export const TRANSLATABLE = {
    GROUP: ['name', 'tagline', 'about'],
    ROUTE: ['name', 'description'],
    DEPOT: ['name', 'description'],
    SHIFT: ['name', 'description'],
    /** A rank's sign-up sheet. */
    SHEET: ['name', 'description'],
    /** One slot on a sheet. */
    SLOT: ['name', 'description'],
    APPLICATION: ['name', 'description'],
    /**
     * A question, a section heading, or an image.
     *
     * `prompt` is the question, the heading, or an image's alt text depending
     * on the type; `description` is the hint under it or a section's body.
     * The choices on a picking question are translated one at a time, keyed by
     * position — `option:0`, `option:1` — because they are stored as an array
     * and there is nothing else stable to key them by. Reordering the English
     * choices moves the translations out from under them, which is the same
     * trade the form editor already makes when it reuses question rows by id.
     */
    QUESTION: ['prompt', 'description'],
    /** An uploaded image's caption, wherever it is shown. */
    MEDIA: ['caption']
} as const satisfies Record<string, readonly string[]>

export type TranslatableEntity = keyof typeof TRANSLATABLE

/** How many choices on one question may be translated. Matches `maxItems`. */
const MAX_OPTIONS = 20

/** Anything longer is not a name or a hint, and `about` is the longest field. */
const MAX_VALUE = 4000

const OPTION = /^option:(\d{1,2})$/

function isTranslatableField(entity: TranslatableEntity, field: string): boolean {
    if ((TRANSLATABLE[entity] as readonly string[]).includes(field)) return true

    if (entity !== 'QUESTION') return false

    const match = OPTION.exec(field)
    return match !== null && Number(match[1]) < MAX_OPTIONS
}

/**
 * The request shape. Loose on purpose — the allow-list above is what decides
 * what is real, and a schema of every field of every entity would be a second
 * copy of it that could disagree.
 */
export const translationsPatch = t.Record(t.String(), t.Record(t.String(), t.String({ maxLength: MAX_VALUE })))
export type translationsPatch = typeof translationsPatch.static

/** The response shape, which is the same thing. */
export const translationsResponse = t.Record(t.String(), t.Record(t.String(), t.String()))

/**
 * Folds a patch into what is already stored.
 *
 * A field the patch does not mention is left exactly as it was, so saving a
 * route's color cannot drop the Ukrainian version of its name. A field the
 * patch *does* mention is replaced wholesale by what arrived — the editor
 * sends everything it holds for that field, so a language missing from it is
 * one somebody deleted.
 *
 * An empty or blank value is a deletion rather than a stored empty string. A
 * translator clearing the box means "I have nothing for this", and the answer
 * to that is the source text, not a blank name on a public page.
 *
 * Unknown fields and unsupported languages are dropped silently. They can only
 * come from a caller that made them up, and refusing the whole save over one
 * would take the group's real edit down with it.
 */
export function mergeTranslations(
    entity: TranslatableEntity,
    current: Translations | null | undefined,
    patch: translationsPatch | undefined
): Translations {
    const merged: Translations = { ...(current ?? {}) }
    if (!patch) return merged

    for (const [field, byLocale] of Object.entries(patch)) {
        if (!isTranslatableField(entity, field)) continue

        const kept: Record<string, string> = {}

        for (const [locale, value] of Object.entries(byLocale)) {
            const text = value.trim()
            if (text.length > 0 && isSupportedLocale(locale)) kept[locale] = text
        }

        if (Object.keys(kept).length > 0) merged[field] = kept
        else delete merged[field]
    }

    return merged
}

/**
 * Everything stored, with anything the allow-list does not recognise removed.
 *
 * Rows written before a field was retired would otherwise keep being handed
 * out, and a reader has no way to tell a retired field from a live one.
 */
export function presentTranslations(
    entity: TranslatableEntity,
    stored: Translations | null | undefined
): Translations {
    const out: Translations = {}

    for (const [field, byLocale] of Object.entries(stored ?? {})) {
        if (isTranslatableField(entity, field)) out[field] = byLocale
    }

    return out
}

/**
 * The `translations` half of a database update, ready to spread.
 *
 * Every editor sends its translations inside the same PATCH as the text they
 * translate, so the two are saved in one statement and cannot half-apply. That
 * means every update path has to pull the field out of the body before
 * spreading the rest into `set()` — a raw patch written straight to the column
 * would replace everything stored with whatever arrived, dropping the fields
 * this particular form does not know about.
 *
 * Returns nothing to spread when the body carried no translations, so a save
 * that is not about them leaves them exactly as they were.
 */
export function translationUpdate(
    entity: TranslatableEntity,
    current: Translations | null | undefined,
    patch: translationsPatch | undefined
): { translations: Translations } | Record<string, never> {
    return patch ? { translations: mergeTranslations(entity, current, patch) } : {}
}
