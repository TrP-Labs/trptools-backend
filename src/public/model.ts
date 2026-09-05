import { t } from 'elysia'
import { translationsResponse } from '../utils/translations'
import { RouteModel } from '../groups/routes/model'
import { RankModel } from '../groups/rank/model'
import { ApplicationModel } from '../applications/model'

export namespace PublicModel {
    export const directoryEntry = t.Object({
        slug: t.String(),
        name: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        tagline: t.String(),
        sourceLocale: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        accentColor: t.String(),
        members: t.Number(),
        routeCount: t.Number(),
        depotCount: t.Number()
    })
    export const directory = t.Array(directoryEntry)
    export type directory = typeof directory.static

    export const directoryQuery = t.Object({
        search: t.Optional(t.String({ maxLength: 60 })),
        limit: t.Optional(t.String())
    })
    export type directoryQuery = typeof directoryQuery.static

    /**
     * A dated occurrence as an anonymous visitor sees it.
     *
     * Deliberately carries no staffing figures. Sign-ups moved to per-rank
     * sheets that only staff at that rank can see, so publishing how many of
     * them are filled would leak exactly what those sheets are gated on.
     */
    export const publicShift = t.Object({
        eventId: t.String(),
        /** Address of the shift's own page. */
        slug: t.String(),
        name: t.String(),
        description: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        color: t.String(),
        start: t.Date(),
        end: t.Date()
    })

    /**
     * Just enough of the group to head a route, depot or shift page and link
     * back to it, without repeating the whole group payload on every child.
     */
    export const groupHeader = t.Object({
        id: t.String(),
        slug: t.String(),
        name: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        tagline: t.String(),
        /** What language the group writes in, so a reader knows the fallback. */
        sourceLocale: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        accentColor: t.String()
    })
    export type groupHeader = typeof groupHeader.static

    /** A route's own page. */
    export const routePage = t.Object({
        group: groupHeader,
        route: RouteModel.routeBody,
        /** The depots this route runs from, resolved for display. */
        depots: t.Array(
            t.Object({
                id: t.String(),
                slug: t.String(),
                number: t.Number(),
                name: t.String(),
                /** Per-language versions of this row's text. See `utils/translations`. */
                translations: translationsResponse,
                color: t.String(),
                icon: t.Union([t.String(), t.Null()])
            })
        )
    })
    export type routePage = typeof routePage.static

    /** A depot's own page, with the routes that run from it. */
    export const depotPage = t.Object({
        group: groupHeader,
        depot: RouteModel.depotBody,
        routes: t.Array(RouteModel.routeBody)
    })
    export type depotPage = typeof depotPage.static

    /** A shift's own page, with its next occurrences. */
    export const shiftPage = t.Object({
        group: groupHeader,
        shift: t.Object({
            eventId: t.String(),
            slug: t.String(),
            name: t.String(),
            description: t.String(),
            /** Per-language versions of this row's text. See `utils/translations`. */
            translations: translationsResponse,
            color: t.String(),
            duration: t.Number(),
            recurrenceText: t.String()
        }),
        occurrences: t.Array(publicShift)
    })
    export type shiftPage = typeof shiftPage.static

    /** Everything the public group page needs, in one request. */
    export const groupPage = t.Object({
        id: t.String(),
        slug: t.String(),
        name: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        bannerImage: t.Union([t.String(), t.Null()]),
        description: t.String(),
        tagline: t.String(),
        about: t.String(),
        sourceLocale: t.String(),
        /** Per-language versions of this row's text. See `utils/translations`. */
        translations: translationsResponse,
        accentColor: t.String(),
        members: t.Number(),
        robloxId: t.String(),

        showRoutes: t.Boolean(),
        showShifts: t.Boolean(),
        showRoster: t.Boolean(),

        routes: t.Array(RouteModel.routeBody),
        depots: t.Array(RouteModel.depotBody),
        roster: RankModel.rosterResponse,
        upcomingShifts: t.Array(publicShift),

        /**
         * Forms the group is currently taking applicants through.
         *
         * Not gated on a section toggle: a form is only here because somebody
         * opened it, which is already the decision to publish it. A closed one
         * is simply absent.
         */
        openApplications: t.Array(ApplicationModel.publicApplicationSummary)
    })
    export type groupPage = typeof groupPage.static
}
