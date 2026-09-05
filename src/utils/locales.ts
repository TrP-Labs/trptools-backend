/**
 * The languages TrP Tools speaks.
 *
 * One list, used by everything the server has to validate a language tag for:
 * the Discord bot's message languages, and the per-language content a group
 * writes for its own routes, depots and shifts.
 *
 * This is the *widest* list — every language the translation project covers.
 * The site's own list is narrower and lives in the frontend's
 * `project.inlang/settings.json`, which is the switch deciding a translation
 * is complete enough to show people. Keeping the server wider is deliberate:
 * shipping a new language should be one line in the frontend, not a
 * coordinated release of both. The server refuses a tag that is not a language
 * at all; the site decides which of them it offers.
 */
export const SUPPORTED_LOCALES = ['en', 'cs', 'de', 'fr', 'pl', 'ru', 'uk'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/**
 * The language everything falls back to when a group has expressed no
 * preference at all — never assumed to be what a group *writes* in. A group's
 * own source language is stored on the group (`groups.sourceLocale`) and is
 * whatever its manager was using when they registered it.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'en'

const supported: readonly string[] = SUPPORTED_LOCALES

export function isSupportedLocale(value: string): value is SupportedLocale {
    return supported.includes(value)
}

/**
 * Narrows a tag to one this instance knows, or nothing.
 *
 * A regional tag resolves to its base language, so a browser asking for
 * `en-GB` or an account carrying `pt-BR` lands somewhere real rather than
 * being discarded. Case is normalised on the way in for the same reason: a tag
 * arrives from an `Accept-Language` header as often as from a dropdown.
 */
export function normaliseLocale(value: string | null | undefined): SupportedLocale | null {
    if (!value) return null

    const tag = value.trim().toLowerCase()
    if (isSupportedLocale(tag)) return tag

    const base = tag.split('-')[0] ?? ''
    return isSupportedLocale(base) ? base : null
}

/**
 * The best language for a request, from what the caller has actually said.
 *
 * Preference order: the account's own setting, then the browser's
 * `Accept-Language`, then English. That order matters — an account setting is
 * a deliberate choice, where the header is whatever the machine was installed
 * with — and it is what stops a group's source language being assumed to be
 * English just because the server's is.
 *
 * The header is parsed for its tags in the order given and not by q-value:
 * browsers already send them in preference order, and a full parse would be
 * a lot of machinery to arrive at the same answer.
 */
export function preferredLocale(
    accountLocale: string | null | undefined,
    acceptLanguage: string | null | undefined
): SupportedLocale {
    const fromAccount = normaliseLocale(accountLocale)
    if (fromAccount) return fromAccount

    for (const part of (acceptLanguage ?? '').split(',')) {
        const tag = normaliseLocale(part.split(';')[0])
        if (tag) return tag
    }

    return DEFAULT_LOCALE
}
