import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'
import { translationsPatch, translationsResponse } from '../utils/translations'

export namespace ApplicationModel {
    export const questionType = t.Union([
        t.Literal('SHORT_TEXT'),
        t.Literal('LONG_TEXT'),
        t.Literal('MULTIPLE_CHOICE'),
        t.Literal('CHECKBOXES'),
        t.Literal('SECTION'),
        t.Literal('IMAGE')
    ])
    export type questionType = typeof questionType.static

    export const submissionStatus = t.Union([t.Literal('PENDING'), t.Literal('APPROVED'), t.Literal('DENIED')])
    export type submissionStatus = typeof submissionStatus.static

    /** One component of a form, as both the builder and the applicant see it. */
    export const question = t.Object({
        id: t.String(),
        type: questionType,
        prompt: t.String(),
        description: t.String(),
        /**
         * Per-language versions of this component's text.
         *
         * `prompt` is the question, the section heading, or an image's alt
         * text depending on the type; `description` is the hint under it.
         * Choices are keyed by position, `option:0` upwards.
         */
        translations: translationsResponse,
        required: t.Boolean(),
        order: t.Number(),
        options: t.Array(t.String()),
        maxLength: t.Union([t.Number(), t.Null()]),
        mediaId: t.Union([t.String(), t.Null()]),
        /** Resolved public URL for an `IMAGE` component. */
        image: t.Union([t.String(), t.Null()])
    })
    export type question = typeof question.static

    /**
     * A question on its way in.
     *
     * `id` is optional and carries the row it came from, so editing a form
     * keeps the answers already given against it. A question with no id is new.
     */
    export const questionInput = t.Object({
        id: t.Optional(t.String({ format: 'uuid' })),
        type: questionType,
        prompt: t.String({ maxLength: 300 }),
        description: t.Optional(t.String({ maxLength: 1000 })),
        /** Per-language versions of the prompt, the hint and the choices. */
        translations: t.Optional(translationsPatch),
        required: t.Optional(t.Boolean()),
        options: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 120 }), { maxItems: 20 })),
        maxLength: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 5000 }), t.Null()])),
        mediaId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()]))
    })
    export type questionInput = typeof questionInput.static

    export const questionsBody = t.Object({
        questions: t.Array(questionInput, { maxItems: 50 })
    })
    export type questionsBody = typeof questionsBody.static

    /** The rank a form applies for, resolved for display. */
    export const boundRank = t.Object({
        id: t.String(),
        name: t.String(),
        color: t.String(),
        rank: t.Number()
    })

    export const applicationSummary = t.Object({
        id: t.String(),
        groupId: t.String(),
        slug: t.String(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this form's name and description. */
        translations: translationsResponse,
        color: t.String(),
        open: t.Boolean(),
        permaDeny: t.Boolean(),
        /** Days a refusal lasts when it is not permanent; null until reopening. */
        denyCooldownDays: t.Union([t.Number(), t.Null()]),
        /** When the current intake began; null on a form never opened. */
        openedAt: t.Union([t.Date(), t.Null()]),
        rank: t.Union([boundRank, t.Null()]),
        questionCount: t.Number(),
        /** Submissions still waiting on a decision — the badge on the card. */
        pendingCount: t.Number(),
        approvedCount: t.Number(),
        deniedCount: t.Number(),
        createdAt: t.Date(),
        updatedAt: t.Date()
    })
    export type applicationSummary = typeof applicationSummary.static

    export const applicationList = t.Array(applicationSummary)
    export type applicationList = typeof applicationList.static

    export const applicationDetail = t.Composite([applicationSummary, t.Object({ questions: t.Array(question) })])
    export type applicationDetail = typeof applicationDetail.static

    export const listQuery = t.Object({ groupId: t.String() })
    export type listQuery = typeof listQuery.static

    export const createBody = t.Object({
        groupId: t.String(),
        name: t.String({ minLength: 1, maxLength: 100 }),
        rankId: t.Optional(t.String({ format: 'uuid' }))
    })
    export type createBody = typeof createBody.static

    export const createResponse = t.Object({ id: t.String(), slug: t.String() })
    export type createResponse = typeof createResponse.static

    export const patchBody = t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        description: t.Optional(t.String({ maxLength: 2000 })),
        /** Per-language versions of this form's name and description. */
        translations: t.Optional(translationsPatch),
        color: t.Optional(globalModel.hexColor),
        open: t.Optional(t.Boolean()),
        permaDeny: t.Optional(t.Boolean()),
        denyCooldownDays: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 365 }), t.Null()])),
        rankId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()]))
    })
    export type patchBody = typeof patchBody.static

    // ----------------------------------------------------------- submissions

    export const applicant = t.Object({
        userId: t.String(),
        robloxId: t.Number(),
        username: t.Union([t.String(), t.Null()]),
        displayName: t.Union([t.String(), t.Null()]),
        avatar: t.Union([t.String(), t.Null()])
    })

    export const answer = t.Object({
        questionId: t.Union([t.String(), t.Null()]),
        type: questionType,
        prompt: t.String(),
        order: t.Number(),
        value: t.String(),
        choices: t.Array(t.String())
    })

    export const submissionSummary = t.Object({
        id: t.String(),
        applicationId: t.String(),
        status: submissionStatus,
        submittedAt: t.Date(),
        reviewedAt: t.Union([t.Date(), t.Null()]),
        reviewNote: t.String(),
        /** Set once an admin let this decision stop counting against them. */
        clearedAt: t.Union([t.Date(), t.Null()]),
        /** Where the applicant was, as they had it when they applied. */
        timezone: t.String(),
        locale: t.String(),
        applicant,
        reviewer: t.Union([applicant, t.Null()])
    })
    export type submissionSummary = typeof submissionSummary.static

    export const submissionDetail = t.Composite([submissionSummary, t.Object({ answers: t.Array(answer) })])
    export type submissionDetail = typeof submissionDetail.static

    export const submissionList = t.Array(submissionSummary)
    export type submissionList = typeof submissionList.static

    export const submissionsQuery = t.Object({
        status: t.Optional(submissionStatus),
        limit: t.Optional(t.String())
    })
    export type submissionsQuery = typeof submissionsQuery.static

    export const reviewBody = t.Object({
        decision: t.Union([t.Literal('APPROVE'), t.Literal('DENY')]),
        note: t.Optional(t.String({ maxLength: 1000 }))
    })
    export type reviewBody = typeof reviewBody.static

    export const answerInput = t.Object({
        questionId: t.String({ format: 'uuid' }),
        value: t.Optional(t.String({ maxLength: 5000 })),
        choices: t.Optional(t.Array(t.String({ maxLength: 120 }), { maxItems: 20 }))
    })

    export const submitBody = t.Object({
        answers: t.Array(answerInput, { maxItems: 50 }),
        /**
         * Where the applicant is. Optional, and defaulted from their account —
         * the form shows what it is about to send and lets them change it for
         * this application without touching their preferences.
         */
        timezone: t.Optional(t.String({ maxLength: 64 })),
        locale: t.Optional(t.String({ maxLength: 8 }))
    })
    export type submitBody = typeof submitBody.static

    export const mySubmission = t.Union([
        t.Object({
            id: t.String(),
            status: submissionStatus,
            submittedAt: t.Date(),
            reviewedAt: t.Union([t.Date(), t.Null()]),
            reviewNote: t.String()
        }),
        t.Null()
    ])
    export type mySubmission = typeof mySubmission.static

    /**
     * Where the caller stands with one form: their last attempt, the rank they
     * already hold, and whether they may apply.
     *
     * One answer rather than several facts for the page to combine, so the
     * form somebody sees and the submission the server accepts can never
     * disagree about why they are being turned away.
     */
    export const myStanding = t.Object({
        submission: mySubmission,
        /** Roblox's own 0-255 ordering; -1 when they hold no role in the group. */
        robloxRank: t.Number(),
        /** The rank on offer, or null where the binding has gone. */
        targetRank: t.Union([t.Number(), t.Null()]),
        canApply: t.Boolean(),
        /** When a refusal lapses on its own, for the page to count down to. */
        retryAt: t.Union([t.Date(), t.Null()]),
        blockedBy: t.Union([
            t.Literal('CLOSED'),
            t.Literal('PENDING'),
            t.Literal('APPROVED'),
            t.Literal('DENIED'),
            t.Literal('RANK_TOO_HIGH'),
            t.Null()
        ]),
        /**
         * What the form will send unless they change it.
         *
         * Null where the account has never been given one, which is the
         * signal for the page to offer what the browser resolves instead of
         * quietly stamping the application UTC.
         */
        timezone: t.Union([t.String(), t.Null()]),
        locale: t.String()
    })
    export type myStanding = typeof myStanding.static

    /** The form as an applicant reads it, with nothing about other applicants. */
    export const publicApplication = t.Object({
        id: t.String(),
        slug: t.String(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this form's name and description. */
        translations: translationsResponse,
        color: t.String(),
        open: t.Boolean(),
        rankName: t.Union([t.String(), t.Null()]),
        rankColor: t.Union([t.String(), t.Null()]),
        questions: t.Array(question)
    })
    export type publicApplication = typeof publicApplication.static

    /** One open form as the group page lists it. */
    export const publicApplicationSummary = t.Object({
        id: t.String(),
        slug: t.String(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this form's name and description. */
        translations: translationsResponse,
        color: t.String(),
        rankName: t.Union([t.String(), t.Null()])
    })
    export type publicApplicationSummary = typeof publicApplicationSummary.static

    export const applicationInvalid = t.Literal('that application does not exist')
    export type applicationInvalid = typeof applicationInvalid.static

    export const needsRank = t.Literal('bind a rank to this application before opening it')
    export type needsRank = typeof needsRank.static

    export const closed = t.Literal('this application is closed')
    export type closed = typeof closed.static

    export const alreadyApplied = t.Literal('you already have an application waiting')
    export type alreadyApplied = typeof alreadyApplied.static

    export const decided = t.Literal('this application has already been decided')
    export type decided = typeof decided.static

    export const outranked = t.Literal('you already hold a rank above the one this form is for')
    export type outranked = typeof outranked.static

    export const notCleared = t.Literal('that record has already been cleared')
    export type notCleared = typeof notCleared.static

    export const missingAnswers = t.Literal('answer every required question')
    export type missingAnswers = typeof missingAnswers.static
}
