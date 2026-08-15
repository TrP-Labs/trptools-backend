import { t } from 'elysia'

export namespace ReportModel {
    export const targetType = t.Union([
        t.Literal('GROUP'),
        t.Literal('ROUTE'),
        t.Literal('DEPOT'),
        t.Literal('MEDIA')
    ])
    export type targetType = typeof targetType.static

    export const createBody = t.Object({
        targetType: targetType,
        targetId: t.String({ format: 'uuid' }),
        reason: t.String({ minLength: 1, maxLength: 80 }),
        details: t.Optional(t.String({ maxLength: 1000 }))
    })
    export type createBody = typeof createBody.static

    export const createResponse = t.Object({
        id: t.String(),
        /** True when filing this report took the content down immediately. */
        hidden: t.Boolean()
    })
    export type createResponse = typeof createResponse.static

    export const adminReport = t.Object({
        id: t.String(),
        targetType: targetType,
        targetId: t.String(),
        reason: t.String(),
        details: t.String(),
        status: t.Union([t.Literal('OPEN'), t.Literal('UPHELD'), t.Literal('DISMISSED')]),
        createdAt: t.Date(),

        reporter: t.Union([
            t.Object({
                userId: t.String(),
                displayName: t.Union([t.String(), t.Null()]),
                username: t.Union([t.String(), t.Null()])
            }),
            t.Null()
        ]),

        /** A snapshot of what was reported, so admins can judge without digging. */
        target: t.Union([
            t.Object({
                label: t.String(),
                description: t.String(),
                moderation: t.Union([t.Literal('VISIBLE'), t.Literal('HIDDEN'), t.Literal('APPROVED')]),
                groupSlug: t.Union([t.String(), t.Null()]),
                groupName: t.Union([t.String(), t.Null()]),
                images: t.Array(t.String())
            }),
            t.Null()
        ])
    })
    export type adminReport = typeof adminReport.static

    export const adminReportList = t.Array(adminReport)
    export type adminReportList = typeof adminReportList.static

    export const listQuery = t.Object({
        status: t.Optional(t.Union([t.Literal('OPEN'), t.Literal('UPHELD'), t.Literal('DISMISSED')])),
        limit: t.Optional(t.String())
    })
    export type listQuery = typeof listQuery.static

    export const resolveBody = t.Object({
        note: t.Optional(t.String({ maxLength: 500 }))
    })
    export type resolveBody = typeof resolveBody.static

    export const overview = t.Object({
        openReports: t.Number(),
        hiddenContent: t.Number(),
        groups: t.Number(),
        users: t.Number()
    })
    export type overview = typeof overview.static

    export const alreadyReported = t.Literal('you have already reported this')
    export type alreadyReported = typeof alreadyReported.static
}
