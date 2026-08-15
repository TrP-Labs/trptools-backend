import { t } from 'elysia'

export namespace globalModel {
    export const internalError = t.Literal('Internal Server Error')
    export type internalError = typeof internalError.static

    export const genericSuccess = t.Literal('Success')
    export type genericSuccess = typeof genericSuccess.static

    export const forbidden = t.Literal('Forbidden')
    export type forbidden = typeof forbidden.static

    export const unauthorized = t.Literal('Unauthorized')
    export type unauthorized = typeof unauthorized.static

    export const badRequest = t.Literal('Bad Request')
    export type badRequest = typeof badRequest.static

    export const notFound = t.Literal('Not Found')
    export type notFound = typeof notFound.static

    export const conflict = t.Literal('Conflict')
    export type conflict = typeof conflict.static

    export const rateLimited = t.Literal('Too Many Requests')
    export type rateLimited = typeof rateLimited.static

    export const visibility = t.Union([
        t.Literal('PUBLIC'),
        t.Literal('UNLISTED'),
        t.Literal('PRIVATE')
    ])
    export type visibility = typeof visibility.static

    /** Every authenticated route shares this response shape for failures. */
    export const authErrors = {
        401: unauthorized,
        403: forbidden
    }

    export const idParam = t.Object({ id: t.String({ format: 'uuid' }) })
    export type idParam = typeof idParam.static

    export const hexColor = t.String({ pattern: '^#([0-9a-fA-F]{6})$', default: '#4287f5' })

    export const shortText = (max = 120) => t.String({ minLength: 1, maxLength: max })
    export const longText = (max = 2000) => t.String({ maxLength: max })
}

export const PERMISSION = {
    NONE: 0,
    DISPATCH: 1,
    HOST: 2,
    MANAGE: 3
} as const

export type PermissionLevel = (typeof PERMISSION)[keyof typeof PERMISSION]
