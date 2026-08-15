import { status } from 'elysia'
import { and, count, desc, eq, inArray, or } from 'drizzle-orm'
import db from '../db'
import { depots, groups, media, reports, routes, users } from '../db/schema'
import type { ModerationStatus, ReportTarget } from '../db/schema'
import { globalModel } from '../utils/globalModel'
import { requireSiteAdmin } from '../utils/authPlugin'
import { moderationAfterReport } from '../utils/moderation'
import { publicUrl } from '../utils/storage'
import type { session } from '../utils/sessionVerifier'
import { ReportModel } from './model'

/** The table a report target lives in, and how to describe it to an admin. */
async function loadTarget(targetType: ReportTarget, targetId: string) {
    switch (targetType) {
        case 'GROUP': {
            const [row] = await db.select().from(groups).where(eq(groups.id, targetId)).limit(1)
            if (!row) return null
            return {
                moderation: row.moderation,
                groupId: row.id,
                label: row.cachedName ?? `Group ${row.robloxId}`,
                description: [row.tagline, row.about].filter(Boolean).join(' — ').slice(0, 500)
            }
        }
        case 'ROUTE': {
            const [row] = await db.select().from(routes).where(eq(routes.id, targetId)).limit(1)
            if (!row) return null
            return {
                moderation: row.moderation,
                groupId: row.groupId,
                label: `Route ${row.name}`,
                description: row.description.slice(0, 500)
            }
        }
        case 'DEPOT': {
            const [row] = await db.select().from(depots).where(eq(depots.id, targetId)).limit(1)
            if (!row) return null
            return {
                moderation: row.moderation,
                groupId: row.groupId,
                label: `Depot ${row.number} — ${row.name}`,
                description: row.description.slice(0, 500)
            }
        }
        case 'MEDIA': {
            const [row] = await db.select().from(media).where(eq(media.id, targetId)).limit(1)
            if (!row) return null
            return {
                moderation: row.moderation,
                groupId: row.groupId,
                label: row.caption || 'Uploaded image',
                description: row.contentType
            }
        }
    }
}

async function setModeration(targetType: ReportTarget, targetId: string, value: ModerationStatus) {
    switch (targetType) {
        case 'GROUP':
            await db.update(groups).set({ moderation: value }).where(eq(groups.id, targetId))
            return
        case 'ROUTE':
            await db.update(routes).set({ moderation: value }).where(eq(routes.id, targetId))
            return
        case 'DEPOT':
            await db.update(depots).set({ moderation: value }).where(eq(depots.id, targetId))
            return
        case 'MEDIA':
            await db.update(media).set({ moderation: value }).where(eq(media.id, targetId))
            return
    }
}

export abstract class Reports {
    /**
     * Files a report and takes the content down straight away.
     *
     * Hiding first and reviewing second is deliberate: the alternative leaves
     * abusive images in front of the public for as long as it takes an admin to
     * wake up. Content already approved by an admin stays visible, so the
     * mechanism cannot be used to grief a legitimate group.
     */
    static async create(body: ReportModel.createBody, session: session): Promise<ReportModel.createResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const target = await loadTarget(body.targetType, body.targetId)
        if (!target) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const duplicate = await db
            .select({ id: reports.id })
            .from(reports)
            .where(
                and(
                    eq(reports.targetType, body.targetType),
                    eq(reports.targetId, body.targetId),
                    eq(reports.reporterId, session.user.userId),
                    eq(reports.status, 'OPEN')
                )
            )
            .limit(1)

        if (duplicate.length > 0) {
            throw status(409, 'you have already reported this' satisfies ReportModel.alreadyReported)
        }

        const [report] = await db
            .insert(reports)
            .values({
                targetType: body.targetType,
                targetId: body.targetId,
                reason: body.reason,
                details: body.details ?? '',
                reporterId: session.user.userId
            })
            .returning({ id: reports.id })

        if (!report) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        const next = moderationAfterReport(target.moderation)
        if (next !== target.moderation) await setModeration(body.targetType, body.targetId, next)

        return { id: report.id, hidden: next === 'HIDDEN' }
    }

    // ------------------------------------------------------------ site admin

    static async list(query: ReportModel.listQuery, session: session): Promise<ReportModel.adminReportList> {
        requireSiteAdmin(session)

        const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200)

        const rows = await db
            .select({
                report: reports,
                reporterId: users.id,
                reporterName: users.cachedDisplayName,
                reporterUsername: users.cachedUsername
            })
            .from(reports)
            .leftJoin(users, eq(reports.reporterId, users.id))
            .where(query.status ? eq(reports.status, query.status) : undefined)
            .orderBy(desc(reports.createdAt))
            .limit(limit)

        // Snapshot each target so an admin can judge without opening the site.
        const enriched = await Promise.all(
            rows.map(async (row) => {
                const target = await loadTarget(row.report.targetType, row.report.targetId)

                let groupSlug: string | null = null
                let groupName: string | null = null
                let images: string[] = []

                if (target) {
                    const [group] = await db
                        .select({ slug: groups.slug, name: groups.cachedName })
                        .from(groups)
                        .where(eq(groups.id, target.groupId))
                        .limit(1)

                    groupSlug = group?.slug ?? null
                    groupName = group?.name ?? null

                    // Reports are mostly about pictures, so bring them along.
                    const imageRows =
                        row.report.targetType === 'MEDIA'
                            ? await db.select().from(media).where(eq(media.id, row.report.targetId))
                            : await db
                                  .select()
                                  .from(media)
                                  .where(
                                      and(
                                          eq(media.groupId, target.groupId),
                                          row.report.targetType === 'GROUP'
                                              ? eq(media.ownerType, 'GROUP')
                                              : eq(media.ownerId, row.report.targetId)
                                      )
                                  )

                    images = imageRows.map((image) => publicUrl(image.key))
                }

                return {
                    id: row.report.id,
                    targetType: row.report.targetType,
                    targetId: row.report.targetId,
                    reason: row.report.reason,
                    details: row.report.details,
                    status: row.report.status,
                    createdAt: row.report.createdAt,
                    reporter: row.reporterId
                        ? {
                              userId: row.reporterId,
                              displayName: row.reporterName,
                              username: row.reporterUsername
                          }
                        : null,
                    target: target
                        ? {
                              label: target.label,
                              description: target.description,
                              moderation: target.moderation,
                              groupSlug,
                              groupName,
                              images
                          }
                        : null
                }
            })
        )

        return enriched
    }

    /** Clears the content and makes it immune to future auto-hiding. */
    static async approve(reportId: string, body: ReportModel.resolveBody, session: session) {
        const admin = requireSiteAdmin(session)

        const [report] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1)
        if (!report) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await setModeration(report.targetType, report.targetId, 'APPROVED')

        // Every open report against this target is settled by the decision.
        await db
            .update(reports)
            .set({
                status: 'DISMISSED',
                resolvedBy: admin.userId,
                resolvedAt: new Date(),
                resolutionNote: body.note ?? ''
            })
            .where(
                and(
                    eq(reports.targetType, report.targetType),
                    eq(reports.targetId, report.targetId),
                    eq(reports.status, 'OPEN')
                )
            )

        return 'Success' as globalModel.genericSuccess
    }

    /** Leaves the content down. */
    static async uphold(reportId: string, body: ReportModel.resolveBody, session: session) {
        const admin = requireSiteAdmin(session)

        const [report] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1)
        if (!report) throw status(404, 'Not Found' satisfies globalModel.notFound)

        await setModeration(report.targetType, report.targetId, 'HIDDEN')

        await db
            .update(reports)
            .set({
                status: 'UPHELD',
                resolvedBy: admin.userId,
                resolvedAt: new Date(),
                resolutionNote: body.note ?? ''
            })
            .where(
                and(
                    eq(reports.targetType, report.targetType),
                    eq(reports.targetId, report.targetId),
                    eq(reports.status, 'OPEN')
                )
            )

        return 'Success' as globalModel.genericSuccess
    }

    static async overview(session: session): Promise<ReportModel.overview> {
        requireSiteAdmin(session)

        const [open, groupCount, userCount, hiddenGroups, hiddenRoutes, hiddenDepots, hiddenMedia] =
            await Promise.all([
                db.select({ total: count() }).from(reports).where(eq(reports.status, 'OPEN')),
                db.select({ total: count() }).from(groups),
                db.select({ total: count() }).from(users),
                db.select({ total: count() }).from(groups).where(eq(groups.moderation, 'HIDDEN')),
                db.select({ total: count() }).from(routes).where(eq(routes.moderation, 'HIDDEN')),
                db.select({ total: count() }).from(depots).where(eq(depots.moderation, 'HIDDEN')),
                db.select({ total: count() }).from(media).where(eq(media.moderation, 'HIDDEN'))
            ])

        const total = (rows: Array<{ total: number }>) => Number(rows[0]?.total ?? 0)

        return {
            openReports: total(open),
            hiddenContent:
                total(hiddenGroups) + total(hiddenRoutes) + total(hiddenDepots) + total(hiddenMedia),
            groups: total(groupCount),
            users: total(userCount)
        }
    }

    /** Every piece of content currently withheld, for the admin queue. */
    static async hidden(session: session): Promise<ReportModel.adminReportList> {
        requireSiteAdmin(session)

        const [hiddenGroups, hiddenRoutes, hiddenDepots, hiddenMedia] = await Promise.all([
            db.select({ id: groups.id }).from(groups).where(eq(groups.moderation, 'HIDDEN')),
            db.select({ id: routes.id }).from(routes).where(eq(routes.moderation, 'HIDDEN')),
            db.select({ id: depots.id }).from(depots).where(eq(depots.moderation, 'HIDDEN')),
            db.select({ id: media.id }).from(media).where(eq(media.moderation, 'HIDDEN'))
        ])

        const ids = [
            ...hiddenGroups.map((row) => row.id),
            ...hiddenRoutes.map((row) => row.id),
            ...hiddenDepots.map((row) => row.id),
            ...hiddenMedia.map((row) => row.id)
        ]

        if (ids.length === 0) return []

        const open = await db
            .select({ id: reports.id })
            .from(reports)
            .where(and(eq(reports.status, 'OPEN'), inArray(reports.targetId, ids)))

        if (open.length === 0) return []

        return this.list({ status: 'OPEN' }, session)
    }
}
