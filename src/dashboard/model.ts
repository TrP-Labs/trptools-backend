import { t } from 'elysia'
import { globalModel } from '../utils/globalModel'

export namespace DashboardModel {
    /**
     * One upcoming shift, already resolved against the group it belongs to.
     *
     * The group's name and icon travel with it because the dashboard mixes
     * every group's shifts into one list, where a shift called "Evening
     * service" says nothing on its own.
     */
    export const upcomingShift = t.Object({
        eventId: t.String(),
        name: t.String(),
        slug: t.String(),
        color: t.String(),
        start: t.Date(),
        end: t.Date(),

        groupId: t.String(),
        groupSlug: t.String(),
        groupName: t.String(),
        groupIcon: t.Union([t.String(), t.Null()]),

        /** Whether this viewer already holds a slot on it. */
        signedUp: t.Boolean(),
        /** Whether they could take one right now. */
        signupsOpen: t.Boolean(),
        /** Whether their rank reaches any sheet on it at all. */
        sheetsAvailable: t.Boolean(),

        // Counted across only the sheets this viewer was served, so the figure
        // always matches what they can actually see.
        filled: t.Number(),
        capacity: t.Number()
    })
    export type upcomingShift = typeof upcomingShift.static

    /** A form with people waiting on a decision, for the review queue card. */
    export const pendingReview = t.Object({
        applicationId: t.String(),
        name: t.String(),
        color: t.String(),
        pendingCount: t.Number(),

        groupId: t.String(),
        groupSlug: t.String(),
        groupName: t.String(),
        groupIcon: t.Union([t.String(), t.Null()])
    })
    export type pendingReview = typeof pendingReview.static

    /**
     * A group as its dashboard card draws it: everything the group list
     * already carries, plus the three live facts the card puts on it.
     */
    export const dashboardGroup = t.Object({
        id: t.String(),
        slug: t.String(),
        robloxId: t.String(),
        name: t.String(),
        icon: t.Union([t.String(), t.Null()]),
        members: t.Number(),
        tagline: t.String(),
        accentColor: t.String(),
        visibility: globalModel.visibility,
        permissionLevel: t.Number(),

        /** The dispatch room open for this group right now, if there is one. */
        roomId: t.Union([t.String(), t.Null()]),
        /** Submissions waiting on a decision. Zero unless the viewer manages it. */
        pendingApplications: t.Number(),
        /** The soonest shift in this group, drawn on its card. */
        nextShift: t.Union([upcomingShift, t.Null()])
    })
    export type dashboardGroup = typeof dashboardGroup.static

    export const dashboardResponse = t.Object({
        /**
         * The group this person pinned, if they still hold a rank in it.
         *
         * Cleared in the response rather than in the database when they do
         * not: a pin made while admin mode was on, or a rank lost for an
         * afternoon, should not silently delete the choice.
         */
        primaryGroupId: t.Union([t.String(), t.Null()]),
        /**
         * Groups on this page, pinned one first, capped.
         *
         * A site admin with admin mode on holds every group on the instance,
         * and each card here costs a membership lookup against Roblox to fill
         * in. The overview shows the first handful and points at
         * `/dashboard` for the rest.
         */
        groups: t.Array(dashboardGroup),
        /** How many they are in altogether, so the page can say what it hid. */
        groupTotal: t.Number(),
        /** Every group's shifts merged into one list, soonest first. */
        shifts: t.Array(upcomingShift),
        reviews: t.Array(pendingReview)
    })
    export type dashboardResponse = typeof dashboardResponse.static
}
