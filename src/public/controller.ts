import { Elysia, t } from 'elysia'
import { PublicModel } from './model'
import { PublicPages } from './service'
import { globalModel } from '../utils/globalModel'

export const publicPages = new Elysia({ prefix: '/public', tags: ['Public'] })
    // These responses do not vary by caller, so they are safe to cache in a
    // CDN. Short TTLs keep an edited group page from feeling stale.
    .onAfterHandle(({ set }) => {
        set.headers['cache-control'] = 'public, max-age=30, s-maxage=120, stale-while-revalidate=600'
    })

    .get('/groups', async ({ query }) => PublicPages.directory(query), {
        query: PublicModel.directoryQuery,
        response: { 200: PublicModel.directory },
        detail: { summary: 'Browse public groups' }
    })

    .get('/groups/:slug', async ({ params: { slug } }) => PublicPages.groupPage(slug), {
        params: t.Object({ slug: t.String({ maxLength: 48 }) }),
        response: {
            200: PublicModel.groupPage,
            404: globalModel.notFound
        },
        detail: {
            summary: 'Read a public group page',
            description: 'Returns only what the group has chosen to publish. Unlisted groups resolve by direct link.'
        }
    })

    .get(
        '/groups/:slug/routes/:routeSlug',
        async ({ params: { slug, routeSlug } }) => PublicPages.routePage(slug, routeSlug),
        {
            params: t.Object({
                slug: t.String({ maxLength: 48 }),
                routeSlug: t.String({ maxLength: 48 })
            }),
            response: {
                200: PublicModel.routePage,
                404: globalModel.notFound
            },
            detail: { summary: 'Read a route\'s own page' }
        }
    )

    .get(
        '/groups/:slug/depots/:depotSlug',
        async ({ params: { slug, depotSlug } }) => PublicPages.depotPage(slug, depotSlug),
        {
            params: t.Object({
                slug: t.String({ maxLength: 48 }),
                depotSlug: t.String({ maxLength: 48 })
            }),
            response: {
                200: PublicModel.depotPage,
                404: globalModel.notFound
            },
            detail: { summary: 'Read a depot\'s own page' }
        }
    )

    .get(
        '/groups/:slug/shifts/:shiftSlug',
        async ({ params: { slug, shiftSlug } }) => PublicPages.shiftPage(slug, shiftSlug),
        {
            params: t.Object({
                slug: t.String({ maxLength: 48 }),
                shiftSlug: t.String({ maxLength: 48 })
            }),
            response: {
                200: PublicModel.shiftPage,
                404: globalModel.notFound
            },
            detail: { summary: 'Read a shift\'s own page' }
        }
    )
