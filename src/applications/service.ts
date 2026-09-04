import { status } from 'elysia'
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm'
import db from '../db'
import {
    applicationAnswers,
    applicationQuestions,
    applicationSubmissions,
    applications,
    groups,
    rankRelations,
    users,
    type Application,
    type ApplicationQuestion
} from '../db/schema'
import { globalModel, PERMISSION } from '../utils/globalModel'
import { GetMembership, assertPermission } from '../utils/groupPermission'
import { requireUser } from '../utils/authPlugin'
import { childSlug, uniqueWithin } from '../utils/slug'
import { mediaUrls } from '../media/service'
import type { session } from '../utils/sessionVerifier'
import { findGroup, recordAudit } from '../groups/service'
import { GroupModel } from '../groups/model'
import { collectAnswers, isChoice, isStatic } from './answers'
import { blockedBy, cooldownEndsAt, type FormState } from './eligibility'
import { ApplicationModel } from './model'

/** Slugs already used by a group's other forms, for `uniqueWithin`. */
async function takenSlugs(groupId: string, exceptId?: string): Promise<Set<string>> {
    const rows = await db
        .select({ slug: applications.slug })
        .from(applications)
        .where(exceptId ? and(eq(applications.groupId, groupId), ne(applications.id, exceptId)) : eq(applications.groupId, groupId))

    return new Set(rows.map((row) => row.slug))
}

async function loadQuestions(applicationIds: string[]): Promise<Map<string, ApplicationModel.question[]>> {
    const grouped = new Map<string, ApplicationModel.question[]>()
    if (applicationIds.length === 0) return grouped

    const rows = await db
        .select()
        .from(applicationQuestions)
        .where(inArray(applicationQuestions.applicationId, applicationIds))
        .orderBy(asc(applicationQuestions.order))

    const images = await mediaUrls(rows.map((row) => row.mediaId))

    for (const row of rows) {
        const bucket = grouped.get(row.applicationId) ?? []
        bucket.push(presentQuestion(row, images))
        grouped.set(row.applicationId, bucket)
    }

    return grouped
}

function presentQuestion(row: ApplicationQuestion, images: Map<string, string>): ApplicationModel.question {
    return {
        id: row.id,
        type: row.type,
        prompt: row.prompt,
        description: row.description,
        required: row.required,
        order: row.order,
        options: row.options,
        maxLength: row.maxLength,
        mediaId: row.mediaId,
        image: row.mediaId ? (images.get(row.mediaId) ?? null) : null
    }
}

type Counts = { PENDING: number; APPROVED: number; DENIED: number }

/** Submission totals per form, so a card can show what is waiting. */
async function loadCounts(applicationIds: string[]): Promise<Map<string, Counts>> {
    const totals = new Map<string, Counts>()
    if (applicationIds.length === 0) return totals

    const rows = await db
        .select({
            applicationId: applicationSubmissions.applicationId,
            status: applicationSubmissions.status,
            total: count()
        })
        .from(applicationSubmissions)
        .where(inArray(applicationSubmissions.applicationId, applicationIds))
        .groupBy(applicationSubmissions.applicationId, applicationSubmissions.status)

    for (const row of rows) {
        const bucket = totals.get(row.applicationId) ?? { PENDING: 0, APPROVED: 0, DENIED: 0 }
        bucket[row.status] = Number(row.total)
        totals.set(row.applicationId, bucket)
    }

    return totals
}

type RankRow = { id: string; cachedName: string; color: string; cachedRank: number }

async function loadRanks(rankIds: Array<string | null>): Promise<Map<string, RankRow>> {
    const wanted = [...new Set(rankIds.filter((id): id is string => Boolean(id)))]
    if (wanted.length === 0) return new Map()

    const rows = await db
        .select({
            id: rankRelations.id,
            cachedName: rankRelations.cachedName,
            color: rankRelations.color,
            cachedRank: rankRelations.cachedRank
        })
        .from(rankRelations)
        .where(inArray(rankRelations.id, wanted))

    return new Map(rows.map((row) => [row.id, row]))
}

function present(
    row: Application,
    ranks: Map<string, RankRow>,
    counts: Map<string, Counts>,
    questionCount: number
): ApplicationModel.applicationSummary {
    const rank = row.rankId ? ranks.get(row.rankId) : undefined
    const total = counts.get(row.id) ?? { PENDING: 0, APPROVED: 0, DENIED: 0 }

    return {
        id: row.id,
        groupId: row.groupId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        color: row.color,
        open: row.open,
        permaDeny: row.permaDeny,
        denyCooldownDays: row.denyCooldownDays,
        openedAt: row.openedAt,
        rank: rank ? { id: rank.id, name: rank.cachedName, color: rank.color, rank: rank.cachedRank } : null,
        questionCount,
        pendingCount: total.PENDING,
        approvedCount: total.APPROVED,
        deniedCount: total.DENIED,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    }
}

/** The form behind an id, with the group's permission check already applied. */
async function findManageable(applicationId: string, session: session): Promise<Application> {
    const [row] = await db.select().from(applications).where(eq(applications.id, applicationId)).limit(1)
    if (!row) throw status(404, 'that application does not exist' satisfies ApplicationModel.applicationInvalid)

    await assertPermission(session, row.groupId, PERMISSION.MANAGE)

    return row
}

/**
 * A rank binding this group actually owns.
 *
 * Checked rather than trusted: without it a manager could point their form at
 * another group's rank and have approvals recorded against it.
 */
async function assertOwnRank(groupId: string, rankId: string) {
    const [rank] = await db
        .select({ id: rankRelations.id })
        .from(rankRelations)
        .where(and(eq(rankRelations.id, rankId), eq(rankRelations.groupId, groupId)))
        .limit(1)

    if (!rank) throw status(404, 'that application does not exist' satisfies ApplicationModel.applicationInvalid)
}

/** The form as the eligibility rules see it. */
function formState(row: Application): FormState {
    return {
        open: row.open,
        hasRank: Boolean(row.rankId),
        permaDeny: row.permaDeny,
        openedAt: row.openedAt,
        denyCooldownDays: row.denyCooldownDays
    }
}

/** Roblox's own ordering for the rank a form is for, or null if unbound. */
async function targetRankOf(rankId: string | null): Promise<number | null> {
    if (!rankId) return null

    const [rank] = await db
        .select({ rank: rankRelations.cachedRank })
        .from(rankRelations)
        .where(eq(rankRelations.id, rankId))
        .limit(1)

    return rank?.rank ?? null
}

/**
 * Somebody's most recent application to one form.
 *
 * Only the latest matters: a decision that has been let go is replaced by
 * whatever they sent afterwards, and an older one cannot block what a newer
 * one does not.
 */
async function lastSubmission(applicationId: string, userId: string) {
    const [row] = await db
        .select()
        .from(applicationSubmissions)
        .where(
            and(
                eq(applicationSubmissions.applicationId, applicationId),
                eq(applicationSubmissions.userId, userId)
            )
        )
        .orderBy(desc(applicationSubmissions.submittedAt))
        .limit(1)

    return row ?? null
}

/**
 * One submission, its form, and its applicant's name, with manage access on
 * the owning group already checked.
 */
async function findReviewable(submissionId: string, session: session) {
    const [row] = await db
        .select({
            id: applicationSubmissions.id,
            groupId: applications.groupId,
            name: applications.name,
            statusValue: applicationSubmissions.status,
            clearedAt: applicationSubmissions.clearedAt,
            username: users.cachedUsername
        })
        .from(applicationSubmissions)
        .innerJoin(applications, eq(applicationSubmissions.applicationId, applications.id))
        .innerJoin(users, eq(applicationSubmissions.userId, users.id))
        .where(eq(applicationSubmissions.id, submissionId))
        .limit(1)

    if (!row) throw status(404, 'that application does not exist' satisfies ApplicationModel.applicationInvalid)

    await assertPermission(session, row.groupId, PERMISSION.MANAGE)

    return row
}

const applicantColumns = {
    userId: users.id,
    robloxId: users.robloxId,
    username: users.cachedUsername,
    displayName: users.cachedDisplayName,
    avatar: users.cachedAvatar
}

/**
 * Open forms on a published group's page.
 *
 * Exported for the public group page, which assembles every section in one
 * query round rather than calling back through the controller.
 */
export async function openApplicationsFor(groupId: string): Promise<ApplicationModel.publicApplicationSummary[]> {
    const rows = await db
        .select({
            id: applications.id,
            slug: applications.slug,
            name: applications.name,
            description: applications.description,
            color: applications.color,
            rankId: applications.rankId,
            rankName: rankRelations.cachedName
        })
        .from(applications)
        // A form whose rank binding has gone answers for nothing, so it is not
        // published even if it was left open.
        .innerJoin(rankRelations, eq(applications.rankId, rankRelations.id))
        .where(and(eq(applications.groupId, groupId), eq(applications.open, true)))
        .orderBy(asc(applications.name))

    return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        color: row.color,
        rankName: row.rankName
    }))
}

export abstract class Applications {
    static async list(groupId: string, session: session): Promise<ApplicationModel.applicationList> {
        const group = await findGroup(groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        const rows = await db
            .select()
            .from(applications)
            .where(eq(applications.groupId, group.id))
            .orderBy(desc(applications.open), asc(applications.name))

        if (rows.length === 0) return []

        const ids = rows.map((row) => row.id)

        const [ranks, counts, questionTotals] = await Promise.all([
            loadRanks(rows.map((row) => row.rankId)),
            loadCounts(ids),
            db
                .select({ applicationId: applicationQuestions.applicationId, total: count() })
                .from(applicationQuestions)
                .where(inArray(applicationQuestions.applicationId, ids))
                .groupBy(applicationQuestions.applicationId)
        ])

        const questionCounts = new Map(questionTotals.map((row) => [row.applicationId, Number(row.total)]))

        return rows.map((row) => present(row, ranks, counts, questionCounts.get(row.id) ?? 0))
    }

    static async get(applicationId: string, session: session): Promise<ApplicationModel.applicationDetail> {
        const row = await findManageable(applicationId, session)

        const [ranks, counts, questions] = await Promise.all([
            loadRanks([row.rankId]),
            loadCounts([row.id]),
            loadQuestions([row.id])
        ])

        const list = questions.get(row.id) ?? []

        return { ...present(row, ranks, counts, list.length), questions: list }
    }

    static async create(
        body: ApplicationModel.createBody,
        session: session
    ): Promise<ApplicationModel.createResponse> {
        const group = await findGroup(body.groupId)
        if (!group) throw status(404, 'group does not exist' satisfies GroupModel.groupInvalid)

        await assertPermission(session, group.id, PERMISSION.MANAGE)

        if (body.rankId) await assertOwnRank(group.id, body.rankId)

        const slug = uniqueWithin(childSlug('application', body.name, Date.now()), await takenSlugs(group.id))

        const [created] = await db
            .insert(applications)
            .values({ groupId: group.id, rankId: body.rankId ?? null, name: body.name, slug })
            .returning({ id: applications.id, slug: applications.slug })

        if (!created) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        await recordAudit(group.id, session.user?.userId ?? null, 'application.create', `Created the ${body.name} application`)

        return created
    }

    static async patch(applicationId: string, body: ApplicationModel.patchBody, session: session) {
        const row = await findManageable(applicationId, session)

        const update: Record<string, unknown> = { ...body, updatedAt: new Date() }

        if (body.rankId) await assertOwnRank(row.groupId, body.rankId)

        // Opening a form that answers for no rank would leave an approval with
        // nothing to approve somebody *for*, so the gate is here rather than
        // only in the dashboard.
        if (body.open) {
            const rankId = body.rankId === undefined ? row.rankId : body.rankId
            if (!rankId) {
                throw status(400, 'bind a rank to this application before opening it' satisfies ApplicationModel.needsRank)
            }

            // Only when it was actually closed. A patch that leaves an open
            // form open must not start a new intake, or saving a colour would
            // quietly release everybody who had been refused.
            if (!row.open) update.openedAt = new Date()
        }

        if (body.name && body.name !== row.name) {
            update.slug = uniqueWithin(
                childSlug('application', body.name, row.id),
                await takenSlugs(row.groupId, row.id)
            )
        }

        await db.update(applications).set(update).where(eq(applications.id, row.id))

        await recordAudit(
            row.groupId,
            session.user?.userId ?? null,
            'application.update',
            `Updated the ${body.name ?? row.name} application`
        )

        return 'Success' as globalModel.genericSuccess
    }

    static async remove(applicationId: string, session: session) {
        const row = await findManageable(applicationId, session)

        await db.delete(applications).where(eq(applications.id, row.id))

        await recordAudit(
            row.groupId,
            session.user?.userId ?? null,
            'application.delete',
            `Deleted the ${row.name} application`
        )

        return 'Success' as globalModel.genericSuccess
    }

    /**
     * Replaces a form's components with the list it was given.
     *
     * Rows are reused by **id** rather than dropped and recreated, which is
     * what keeps answers attached to the question they answered: an editor
     * that rewrote every row would orphan every archived application the first
     * time somebody reordered the form.
     */
    static async putQuestions(
        applicationId: string,
        body: ApplicationModel.questionsBody,
        session: session
    ): Promise<ApplicationModel.applicationDetail> {
        const row = await findManageable(applicationId, session)

        const existing = await db
            .select({ id: applicationQuestions.id })
            .from(applicationQuestions)
            .where(eq(applicationQuestions.applicationId, row.id))

        const known = new Set(existing.map((question) => question.id))
        const keep = new Set<string>()

        for (const [index, question] of body.questions.entries()) {
            const options = isChoice(question.type) ? (question.options ?? []) : []

            // A question nobody can answer cannot be required. A choice
            // question left with no choices is exactly that, and marking it
            // required would leave applicants on a form that refuses every
            // attempt with nothing on screen to fix.
            const answerable = !isStatic(question.type) && (!isChoice(question.type) || options.length > 0)

            const values = {
                type: question.type,
                prompt: question.prompt,
                description: question.description ?? '',
                required: answerable && (question.required ?? false),
                order: index,
                options,
                maxLength: question.maxLength ?? null,
                mediaId: question.type === 'IMAGE' ? (question.mediaId ?? null) : null
            }

            if (question.id && known.has(question.id)) {
                keep.add(question.id)
                await db.update(applicationQuestions).set(values).where(eq(applicationQuestions.id, question.id))
            } else {
                const [created] = await db
                    .insert(applicationQuestions)
                    .values({ applicationId: row.id, ...values })
                    .returning({ id: applicationQuestions.id })

                if (created) keep.add(created.id)
            }
        }

        const removed = existing.filter((question) => !keep.has(question.id)).map((question) => question.id)
        if (removed.length > 0) {
            await db.delete(applicationQuestions).where(inArray(applicationQuestions.id, removed))
        }

        await db.update(applications).set({ updatedAt: new Date() }).where(eq(applications.id, row.id))

        await recordAudit(
            row.groupId,
            session.user?.userId ?? null,
            'application.questions',
            `Edited the ${row.name} application form`
        )

        return Applications.get(row.id, session)
    }

    // ----------------------------------------------------------- submissions

    static async submissions(
        applicationId: string,
        query: ApplicationModel.submissionsQuery,
        session: session
    ): Promise<ApplicationModel.submissionList> {
        const row = await findManageable(applicationId, session)

        const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200)

        const filters = [eq(applicationSubmissions.applicationId, row.id)]
        if (query.status) filters.push(eq(applicationSubmissions.status, query.status))

        const rows = await db
            .select({
                id: applicationSubmissions.id,
                applicationId: applicationSubmissions.applicationId,
                statusValue: applicationSubmissions.status,
                submittedAt: applicationSubmissions.submittedAt,
                reviewedAt: applicationSubmissions.reviewedAt,
                reviewNote: applicationSubmissions.reviewNote,
                reviewedBy: applicationSubmissions.reviewedBy,
                clearedAt: applicationSubmissions.clearedAt,
                timezone: applicationSubmissions.timezone,
                locale: applicationSubmissions.locale,
                ...applicantColumns
            })
            .from(applicationSubmissions)
            .innerJoin(users, eq(applicationSubmissions.userId, users.id))
            .where(and(...filters))
            // Oldest first while pending — whoever has been waiting longest is
            // who a reviewer should reach next — newest first once decided,
            // where the archive reads as a history.
            .orderBy(
                query.status === 'PENDING'
                    ? asc(applicationSubmissions.submittedAt)
                    : desc(applicationSubmissions.submittedAt)
            )
            .limit(limit)

        const reviewers = await loadReviewers(rows.map((submission) => submission.reviewedBy))

        return rows.map((submission) => ({
            id: submission.id,
            applicationId: submission.applicationId,
            status: submission.statusValue,
            submittedAt: submission.submittedAt,
            reviewedAt: submission.reviewedAt,
            reviewNote: submission.reviewNote,
            clearedAt: submission.clearedAt,
            timezone: submission.timezone,
            locale: submission.locale,
            applicant: {
                userId: submission.userId,
                robloxId: submission.robloxId,
                username: submission.username,
                displayName: submission.displayName,
                avatar: submission.avatar
            },
            reviewer: submission.reviewedBy ? (reviewers.get(submission.reviewedBy) ?? null) : null
        }))
    }

    static async submission(submissionId: string, session: session): Promise<ApplicationModel.submissionDetail> {
        const [row] = await db
            .select({
                id: applicationSubmissions.id,
                applicationId: applicationSubmissions.applicationId,
                groupId: applications.groupId,
                statusValue: applicationSubmissions.status,
                submittedAt: applicationSubmissions.submittedAt,
                reviewedAt: applicationSubmissions.reviewedAt,
                reviewNote: applicationSubmissions.reviewNote,
                reviewedBy: applicationSubmissions.reviewedBy,
                clearedAt: applicationSubmissions.clearedAt,
                timezone: applicationSubmissions.timezone,
                locale: applicationSubmissions.locale,
                ...applicantColumns
            })
            .from(applicationSubmissions)
            .innerJoin(applications, eq(applicationSubmissions.applicationId, applications.id))
            .innerJoin(users, eq(applicationSubmissions.userId, users.id))
            .where(eq(applicationSubmissions.id, submissionId))
            .limit(1)

        if (!row) throw status(404, 'that application does not exist' satisfies ApplicationModel.applicationInvalid)

        await assertPermission(session, row.groupId, PERMISSION.MANAGE)

        const [answers, reviewers] = await Promise.all([
            db
                .select()
                .from(applicationAnswers)
                .where(eq(applicationAnswers.submissionId, row.id))
                .orderBy(asc(applicationAnswers.order)),
            loadReviewers([row.reviewedBy])
        ])

        return {
            id: row.id,
            applicationId: row.applicationId,
            status: row.statusValue,
            submittedAt: row.submittedAt,
            reviewedAt: row.reviewedAt,
            reviewNote: row.reviewNote,
            clearedAt: row.clearedAt,
            timezone: row.timezone,
            locale: row.locale,
            applicant: {
                userId: row.userId,
                robloxId: row.robloxId,
                username: row.username,
                displayName: row.displayName,
                avatar: row.avatar
            },
            reviewer: row.reviewedBy ? (reviewers.get(row.reviewedBy) ?? null) : null,
            answers: answers.map((answer) => ({
                questionId: answer.questionId,
                type: answer.type,
                prompt: answer.prompt,
                order: answer.order,
                value: answer.value,
                choices: answer.choices
            }))
        }
    }

    /**
     * Approves or denies one application.
     *
     * Both outcomes archive: the row keeps everything that was written, who
     * decided and when, and moves to the list for that decision. Nothing is
     * deleted, so a group can always go back to a decision it made.
     *
     * Approving records the decision; it does not touch Roblox. Promotions
     * happen in the group, where they always have — TrPTools reads Roblox for
     * permission and writing back would need a scope the credential ladder
     * does not carry.
     */
    static async review(submissionId: string, body: ApplicationModel.reviewBody, session: session) {
        const user = requireUser(session)

        const [row] = await db
            .select({
                id: applicationSubmissions.id,
                groupId: applications.groupId,
                name: applications.name,
                statusValue: applicationSubmissions.status,
                username: users.cachedUsername
            })
            .from(applicationSubmissions)
            .innerJoin(applications, eq(applicationSubmissions.applicationId, applications.id))
            .innerJoin(users, eq(applicationSubmissions.userId, users.id))
            .where(eq(applicationSubmissions.id, submissionId))
            .limit(1)

        if (!row) throw status(404, 'that application does not exist' satisfies ApplicationModel.applicationInvalid)

        await assertPermission(session, row.groupId, PERMISSION.MANAGE)

        if (row.statusValue !== 'PENDING') {
            throw status(409, 'this application has already been decided' satisfies ApplicationModel.decided)
        }

        const decision = body.decision === 'APPROVE' ? 'APPROVED' : 'DENIED'

        await db
            .update(applicationSubmissions)
            .set({
                status: decision,
                reviewedAt: new Date(),
                reviewedBy: user.userId,
                reviewNote: body.note ?? ''
            })
            .where(eq(applicationSubmissions.id, row.id))

        await recordAudit(
            row.groupId,
            user.userId,
            'application.review',
            `${decision === 'APPROVED' ? 'Approved' : 'Denied'} ${row.username ?? 'an applicant'} for ${row.name}`
        )

        return 'Success' as globalModel.genericSuccess
    }

    // ------------------------------------------------------------- applying

    /**
     * The form as an applicant reads it.
     *
     * Session-free and identical for every caller, so it stays cacheable: what
     * *this* person has already sent is a separate call.
     */
    static async publicForm(groupSlug: string, applicationSlug: string): Promise<ApplicationModel.publicApplication> {
        const [row] = await db
            .select({
                application: applications,
                rankName: rankRelations.cachedName,
                rankColor: rankRelations.color,
                visibility: groups.visibility,
                moderation: groups.moderation
            })
            .from(applications)
            .innerJoin(groups, eq(applications.groupId, groups.id))
            .leftJoin(rankRelations, eq(applications.rankId, rankRelations.id))
            .where(and(eq(groups.slug, groupSlug), eq(applications.slug, applicationSlug)))
            .limit(1)

        if (!row || row.visibility === 'PRIVATE' || row.moderation === 'HIDDEN') {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        const questions = (await loadQuestions([row.application.id])).get(row.application.id) ?? []

        return {
            id: row.application.id,
            slug: row.application.slug,
            name: row.application.name,
            description: row.application.description,
            color: row.application.color,
            // A form is only truly open while it still answers for a rank.
            open: row.application.open && Boolean(row.application.rankId),
            rankName: row.rankName,
            rankColor: row.rankColor,
            questions
        }
    }

    /**
     * Where the caller stands with this form.
     *
     * The one call the apply page needs beyond the form itself: their last
     * attempt, the rank they already hold in the group, and whether they may
     * apply — worked out by the same `blockedBy` the submission goes through,
     * so the page never offers a form the server would refuse.
     */
    static async standing(applicationId: string, session: session): Promise<ApplicationModel.myStanding> {
        const user = requireUser(session)

        const [application] = await db
            .select()
            .from(applications)
            .where(eq(applications.id, applicationId))
            .limit(1)

        if (!application) {
            throw status(404, 'that application does not exist' satisfies ApplicationModel.applicationInvalid)
        }

        const [preferences] = await db
            .select({ timezone: users.timezone, locale: users.locale })
            .from(users)
            .where(eq(users.id, user.userId))
            .limit(1)

        const [row, membership, target] = await Promise.all([
            lastSubmission(application.id, user.userId),
            GetMembership(user.userId, application.groupId),
            targetRankOf(application.rankId)
        ])

        const state = formState(application)
        const blocker = blockedBy(state, row, membership.robloxRank, target)

        return {
            submission: row
                ? {
                      id: row.id,
                      status: row.status,
                      submittedAt: row.submittedAt,
                      reviewedAt: row.reviewedAt,
                      reviewNote: row.reviewNote
                  }
                : null,
            robloxRank: membership.robloxRank,
            targetRank: target,
            canApply: blocker === null,
            // Only worth showing while it is actually what is in the way.
            retryAt: blocker === 'DENIED' && row ? cooldownEndsAt(row, state) : null,
            blockedBy: blocker,
            timezone: preferences?.timezone ?? 'UTC',
            // `||`, not `??`: the account's locale is null when it follows the
            // browser, and the apply form needs a real tag to snapshot against
            // the submission. The page overrides this with `navigator.language`
            // anyway — this is only what it starts from.
            locale: preferences?.locale || 'en'
        }
    }

    /**
     * Lets a decision stop counting against the person it was made about.
     *
     * Keeps the application, the answers and the decision — only the lock-out
     * goes. Undoing a refusal and destroying the record of it are different
     * things, and a group reaching for the first should not have to do the
     * second.
     */
    static async clearRecord(submissionId: string, session: session) {
        const row = await findReviewable(submissionId, session)

        if (row.clearedAt) {
            throw status(409, 'that record has already been cleared' satisfies ApplicationModel.notCleared)
        }

        await db
            .update(applicationSubmissions)
            .set({ clearedAt: new Date() })
            .where(eq(applicationSubmissions.id, row.id))

        await recordAudit(
            row.groupId,
            session.user?.userId ?? null,
            'application.clear',
            `Cleared ${row.username ?? 'an applicant'}'s record on ${row.name}`
        )

        return 'Success' as globalModel.genericSuccess
    }

    /** Removes an archived application outright, answers and all. */
    static async deleteSubmission(submissionId: string, session: session) {
        const row = await findReviewable(submissionId, session)

        await db.delete(applicationSubmissions).where(eq(applicationSubmissions.id, row.id))

        await recordAudit(
            row.groupId,
            session.user?.userId ?? null,
            'application.record.delete',
            `Deleted ${row.username ?? 'an applicant'}'s application to ${row.name}`
        )

        return 'Success' as globalModel.genericSuccess
    }

    static async submit(applicationId: string, body: ApplicationModel.submitBody, session: session) {
        const user = requireUser(session)

        const [application] = await db.select().from(applications).where(eq(applications.id, applicationId)).limit(1)
        if (!application) {
            throw status(404, 'that application does not exist' satisfies ApplicationModel.applicationInvalid)
        }

        const [previous, membership, target] = await Promise.all([
            lastSubmission(application.id, user.userId),
            GetMembership(user.userId, application.groupId),
            targetRankOf(application.rankId)
        ])

        // Every refusal comes from one place, so what the form showed and what
        // the server accepts cannot drift apart.
        switch (blockedBy(formState(application), previous, membership.robloxRank, target)) {
            case 'CLOSED':
                throw status(409, 'this application is closed' satisfies ApplicationModel.closed)
            case 'RANK_TOO_HIGH':
                throw status(
                    403,
                    'you already hold a rank above the one this form is for' satisfies ApplicationModel.outranked
                )
            case 'PENDING':
                throw status(409, 'you already have an application waiting' satisfies ApplicationModel.alreadyApplied)
            case 'APPROVED':
            case 'DENIED':
                throw status(409, 'this application has already been decided' satisfies ApplicationModel.decided)
        }

        const questions = await db
            .select()
            .from(applicationQuestions)
            .where(eq(applicationQuestions.applicationId, application.id))
            .orderBy(asc(applicationQuestions.order))

        const { answers: rows, missing } = collectAnswers(questions, body.answers)

        if (missing.length > 0) {
            throw status(400, 'answer every required question' satisfies ApplicationModel.missingAnswers)
        }

        const [preferences] = await db
            .select({ timezone: users.timezone, locale: users.locale })
            .from(users)
            .where(eq(users.id, user.userId))
            .limit(1)

        const [submission] = await db
            .insert(applicationSubmissions)
            .values({
                applicationId: application.id,
                userId: user.userId,
                // Sent with the form so a reviewer can see when somebody is
                // actually around, defaulted from the account when the form
                // did not say.
                timezone: body.timezone?.trim() || preferences?.timezone || 'UTC',
                locale: body.locale?.trim() || preferences?.locale || 'en'
            })
            .returning({ id: applicationSubmissions.id })

        if (!submission) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        if (rows.length > 0) {
            await db
                .insert(applicationAnswers)
                .values(rows.map((row) => ({ submissionId: submission.id, ...row })))
        }

        await recordAudit(
            application.groupId,
            user.userId,
            'application.submit',
            `Applied for ${application.name}`
        )

        return 'Success' as globalModel.genericSuccess
    }
}

/** Reviewer identities for a set of submissions, keyed by user id. */
async function loadReviewers(ids: Array<string | null>): Promise<Map<string, ApplicationModel.submissionSummary['applicant']>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
    if (wanted.length === 0) return new Map()

    const rows = await db.select(applicantColumns).from(users).where(inArray(users.id, wanted))

    return new Map(rows.map((row) => [row.userId, row]))
}
