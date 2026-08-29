import { Elysia, t } from 'elysia'
import { ApplicationModel } from './model'
import { Applications } from './service'
import { GroupModel } from '../groups/model'
import { globalModel } from '../utils/globalModel'
import { sessionPlugin, requireUser } from '../utils/authPlugin'
import { rateLimit } from '../utils/ratelimit'

const applicationParam = t.Object({ applicationId: t.String({ format: 'uuid' }) })

export const applicationRoutes = new Elysia({ prefix: '/applications', tags: ['Applications'] })
    .use(sessionPlugin)

    .get('/', async ({ query, session }) => Applications.list(query.groupId, session), {
        query: ApplicationModel.listQuery,
        response: {
            200: ApplicationModel.applicationList,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: GroupModel.groupInvalid
        },
        detail: { summary: 'List a group\'s application forms' }
    })

    .post('/', async ({ body, session }) => Applications.create(body, session), {
        body: ApplicationModel.createBody,
        response: {
            200: ApplicationModel.createResponse,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: t.Union([GroupModel.groupInvalid, ApplicationModel.applicationInvalid])
        },
        detail: { summary: 'Create an application form' }
    })

    // Read before the parameterised group, so `/submissions/:id` is not taken
    // for an application id.
    .get('/submissions/:submissionId', async ({ params: { submissionId }, session }) => Applications.submission(submissionId, session), {
        params: t.Object({ submissionId: t.String({ format: 'uuid' }) }),
        response: {
            200: ApplicationModel.submissionDetail,
            401: globalModel.unauthorized,
            403: globalModel.forbidden,
            404: ApplicationModel.applicationInvalid
        },
        detail: { summary: 'Read one submitted application, with its answers' }
    })

    .post(
        '/submissions/:submissionId/review',
        async ({ params: { submissionId }, body, session }) => Applications.review(submissionId, body, session),
        {
            params: t.Object({ submissionId: t.String({ format: 'uuid' }) }),
            body: ApplicationModel.reviewBody,
            response: {
                200: globalModel.genericSuccess,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: ApplicationModel.applicationInvalid,
                409: ApplicationModel.decided
            },
            detail: {
                summary: 'Approve or deny an application',
                description:
                    'Both outcomes archive the submission with who decided and when. Nothing is deleted, and a ' +
                    'decision cannot be taken twice.'
            }
        }
    )

    .post(
        '/submissions/:submissionId/clear',
        async ({ params: { submissionId }, session }) => Applications.clearRecord(submissionId, session),
        {
            params: t.Object({ submissionId: t.String({ format: 'uuid' }) }),
            response: {
                200: globalModel.genericSuccess,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: ApplicationModel.applicationInvalid,
                409: ApplicationModel.notCleared
            },
            detail: {
                summary: 'Let a decision stop counting against its applicant',
                description:
                    'Keeps the application, the answers and the decision, and only lifts the lock-out it put on ' +
                    'that person. Use this rather than deleting to let somebody apply again.'
            }
        }
    )

    .delete(
        '/submissions/:submissionId',
        async ({ params: { submissionId }, session }) => Applications.deleteSubmission(submissionId, session),
        {
            params: t.Object({ submissionId: t.String({ format: 'uuid' }) }),
            response: {
                200: globalModel.genericSuccess,
                401: globalModel.unauthorized,
                403: globalModel.forbidden,
                404: ApplicationModel.applicationInvalid
            },
            detail: {
                summary: 'Delete one submitted application',
                description: 'Removes the record and its answers outright. Clearing keeps them.'
            }
        }
    )

    .group('/:applicationId', (app) =>
        app
            .get('/', async ({ params: { applicationId }, session }) => Applications.get(applicationId, session), {
                params: applicationParam,
                response: {
                    200: ApplicationModel.applicationDetail,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: ApplicationModel.applicationInvalid
                },
                detail: { summary: 'Read one application form, with its questions' }
            })

            .patch('/', async ({ params: { applicationId }, body, session }) => Applications.patch(applicationId, body, session), {
                params: applicationParam,
                body: ApplicationModel.patchBody,
                response: {
                    200: globalModel.genericSuccess,
                    400: ApplicationModel.needsRank,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: ApplicationModel.applicationInvalid
                },
                detail: {
                    summary: 'Update an application form',
                    description: 'Closing a form stops new submissions and keeps every one already made.'
                }
            })

            .delete('/', async ({ params: { applicationId }, session }) => Applications.remove(applicationId, session), {
                params: applicationParam,
                response: {
                    200: globalModel.genericSuccess,
                    401: globalModel.unauthorized,
                    403: globalModel.forbidden,
                    404: ApplicationModel.applicationInvalid
                },
                detail: {
                    summary: 'Delete an application form',
                    description: 'Takes its submissions with it. Close the form instead to keep them.'
                }
            })

            .put(
                '/questions',
                async ({ params: { applicationId }, body, session }) => Applications.putQuestions(applicationId, body, session),
                {
                    params: applicationParam,
                    body: ApplicationModel.questionsBody,
                    response: {
                        200: ApplicationModel.applicationDetail,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: ApplicationModel.applicationInvalid
                    },
                    detail: {
                        summary: 'Replace an application\'s questions',
                        description:
                            'The whole form is sent at once, in order. A question carrying the id it already had ' +
                            'is updated in place, so answers already given stay attached to it.'
                    }
                }
            )

            .get(
                '/submissions',
                async ({ params: { applicationId }, query, session }) => Applications.submissions(applicationId, query, session),
                {
                    params: applicationParam,
                    query: ApplicationModel.submissionsQuery,
                    response: {
                        200: ApplicationModel.submissionList,
                        401: globalModel.unauthorized,
                        403: globalModel.forbidden,
                        404: ApplicationModel.applicationInvalid
                    },
                    detail: {
                        summary: 'List submissions',
                        description: 'Filter by status to read the pending queue or either archive.'
                    }
                }
            )

            .get('/me', async ({ params: { applicationId }, session }) => Applications.standing(applicationId, session), {
                params: applicationParam,
                response: {
                    200: ApplicationModel.myStanding,
                    401: globalModel.unauthorized,
                    404: ApplicationModel.applicationInvalid
                },
                detail: {
                    summary: 'Where you stand with this form',
                    description:
                        'Your last application, the rank you already hold in the group, and whether you may ' +
                        'apply — decided by the same rules the submission goes through.'
                }
            })

            .post(
                '/submit',
                async ({ params: { applicationId }, body, session }) => {
                    const user = requireUser(session)
                    // A form is a cheap thing to post repeatedly, and every one
                    // lands in somebody's review queue.
                    await rateLimit('application:submit', user.userId, 10, 3600)

                    return Applications.submit(applicationId, body, session)
                },
                {
                    params: applicationParam,
                    body: ApplicationModel.submitBody,
                    response: {
                        200: globalModel.genericSuccess,
                        400: ApplicationModel.missingAnswers,
                        401: globalModel.unauthorized,
                        404: ApplicationModel.applicationInvalid,
                        403: ApplicationModel.outranked,
                        409: t.Union([
                            ApplicationModel.closed,
                            ApplicationModel.alreadyApplied,
                            ApplicationModel.decided
                        ]),
                        429: globalModel.rateLimited
                    },
                    detail: {
                        summary: 'Apply',
                        description:
                            'Answers are stored with a copy of the question they answered, so editing the form ' +
                            'later never re-labels what somebody wrote.'
                    }
                }
            )
    )
