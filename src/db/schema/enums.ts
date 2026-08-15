import { pgEnum } from 'drizzle-orm/pg-core'

export const visibilityEnum = pgEnum('visibility', ['PUBLIC', 'UNLISTED', 'PRIVATE'])

export const routeShapeEnum = pgEnum('route_shape', ['AUTO', 'CIRCLE', 'RECTANGLE', 'DIAMOND', 'HEXAGON'])

export const vehicleCategoryEnum = pgEnum('vehicle_category', ['TROLLEYBUS', 'SERVICE', 'STAFF', 'OTHER'])

export const routePreferenceEnum = pgEnum('route_preference', ['FAVORITE', 'DISLIKE'])

/**
 * Moderation state for anything a group can put in front of the public.
 *
 * `VISIBLE` is the default. A report flips content to `HIDDEN` immediately,
 * which is what stops abuse being visible while a human looks at it. Once a
 * site admin marks it `APPROVED` it stays up, and further reports no longer
 * hide it — otherwise a single determined reporter could keep legitimate
 * content suppressed indefinitely.
 */
export const moderationEnum = pgEnum('moderation_status', ['VISIBLE', 'HIDDEN', 'APPROVED'])

export const reportTargetEnum = pgEnum('report_target', ['GROUP', 'ROUTE', 'DEPOT', 'MEDIA'])

export const reportStatusEnum = pgEnum('report_status', ['OPEN', 'UPHELD', 'DISMISSED'])

export const mediaOwnerEnum = pgEnum('media_owner', ['GROUP', 'ROUTE', 'DEPOT'])

export type Visibility = (typeof visibilityEnum.enumValues)[number]
export type RouteShape = (typeof routeShapeEnum.enumValues)[number]
export type VehicleCategory = (typeof vehicleCategoryEnum.enumValues)[number]
export type ModerationStatus = (typeof moderationEnum.enumValues)[number]
export type ReportTarget = (typeof reportTargetEnum.enumValues)[number]
export type MediaOwner = (typeof mediaOwnerEnum.enumValues)[number]
