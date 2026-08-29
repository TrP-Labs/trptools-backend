/**
 * Whether one person may apply to one form right now.
 *
 * Four rules interact here — the form being open, the rank the applicant
 * already holds, the intake a decision was made in, and an admin clearing a
 * record — and every one of them has a plausible wrong version. They live
 * apart from the service, importing nothing, so `eligibility.test.ts` can pin
 * them without a database; the same reasoning as `answers.ts` and
 * `rooms/dispatch/assign.ts`.
 *
 * The API asks this before accepting a submission and the apply page asks it
 * before drawing the form, so the page and the server can never disagree about
 * why somebody is being turned away.
 */

export type SubmissionStatus = 'PENDING' | 'APPROVED' | 'DENIED'

export type LastSubmission = {
    status: SubmissionStatus
    /** Null while still pending. */
    reviewedAt: Date | null
    /** Set when an admin let the decision stop counting. */
    clearedAt: Date | null
}

export type FormState = {
    open: boolean
    /** A form with no rank bound answers for nothing, so it is never open. */
    hasRank: boolean
    permaDeny: boolean
    /** When the current intake began. Null on a form never opened. */
    openedAt: Date | null
    /**
     * How long a refusal keeps somebody out, in days. Null means "until this
     * intake ends", which is the plain rule above.
     *
     * A group running one long intake has no closing moment to release people
     * at, so this is the other way of saying the same thing: a refusal is
     * temporary, and here is how temporary. Ignored under `permaDeny`, where
     * the whole point is that it does not lapse.
     */
    denyCooldownDays: number | null
}

/**
 * Why somebody cannot apply, or `null` when they can.
 *
 * `PENDING` is their own application waiting; `APPROVED` and `DENIED` are a
 * decision that still stands.
 */
export type Blocker = 'CLOSED' | 'PENDING' | 'APPROVED' | 'DENIED' | 'RANK_TOO_HIGH'

/**
 * Whether a decision still counts against the person it was made about.
 *
 * A refusal belongs to the intake it was made in: reopening the form starts a
 * new one and lets it go. `permaDeny` is the exception a group opts into, and
 * covers refusals only — somebody approved and since demoted is precisely who
 * should be able to apply again.
 */
export function decisionStands(submission: LastSubmission, form: FormState, now = new Date()): boolean {
    if (submission.status === 'PENDING') return true
    if (submission.clearedAt) return false
    if (submission.status === 'DENIED' && form.permaDeny) return true

    // No review timestamp on a decided row is not something that should
    // happen; treating it as current is the safe direction, since the wrong
    // guess merely asks an admin to clear the record.
    if (!submission.reviewedAt) return true

    // A form that has never been opened has no intake to belong to, so the
    // decision is as recent as anything can be here.
    const withinIntake = !form.openedAt || submission.reviewedAt.getTime() >= form.openedAt.getTime()
    if (!withinIntake) return false

    const lapses = cooldownEndsAt(submission, form)
    return !lapses || now.getTime() < lapses.getTime()
}

/**
 * When a refusal lapses on the clock, or null when only the form closing (or
 * an admin) will release it.
 */
export function cooldownEndsAt(submission: LastSubmission, form: FormState): Date | null {
    if (submission.status !== 'DENIED') return null
    if (form.permaDeny) return null
    if (!form.denyCooldownDays || form.denyCooldownDays <= 0) return null
    if (!submission.reviewedAt) return null

    return new Date(submission.reviewedAt.getTime() + form.denyCooldownDays * 24 * 60 * 60 * 1000)
}

/**
 * Whether the applicant already outranks what the form is for.
 *
 * Strictly higher, and only when both sides are known: a non-member is `-1`,
 * below Roblox's own lowest rank, and a form whose rank binding has gone has
 * nothing to compare against.
 */
export function outranksForm(robloxRank: number, targetRank: number | null): boolean {
    if (targetRank === null) return false
    return robloxRank > targetRank
}

export function blockedBy(
    form: FormState,
    submission: LastSubmission | null,
    robloxRank: number,
    targetRank: number | null,
    now = new Date()
): Blocker | null {
    // Closed comes first: it is true of everybody, and is what the page should
    // say rather than a reason personal to the reader.
    if (!form.open || !form.hasRank) return 'CLOSED'

    if (outranksForm(robloxRank, targetRank)) return 'RANK_TOO_HIGH'

    if (submission && decisionStands(submission, form, now)) return submission.status

    return null
}

export const canApply = (
    form: FormState,
    submission: LastSubmission | null,
    robloxRank: number,
    targetRank: number | null
): boolean => blockedBy(form, submission, robloxRank, targetRank) === null
