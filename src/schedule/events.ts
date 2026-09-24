import { dataRedis } from '../utils/redis'
import { env } from '../utils/env'

/**
 * Delivery paths for sign-up changes made on the web. The Docker bot listens
 * on Redis pub/sub; a configured Worker receives the same change over HTTPS.
 * A message sent with nobody listening is simply dropped when no bot is connected.
 */
export const SIGNUP_CHANNEL = 'bot.signup'

export type SignupChange = {
    groupId: string
    eventId: string
    /** ISO 8601, milliseconds preserved. */
    occurrence: string
    /** The sheet that changed, so the bot edits one message rather than all. */
    sheetId: string
}

export async function publishSignupChange(
    groupId: string,
    eventId: string,
    occurrence: Date,
    sheetId: string
) {
    const payload: SignupChange = {
        groupId,
        eventId,
        // `toISOString` rather than `String(date)`, which drops milliseconds
        // and would land the bot on an occurrence that matches nothing.
        occurrence: occurrence.toISOString(),
        sheetId
    }

    // Fan-out is best effort. A dropped notification costs a stale embed until
    // the next edit, never a lost signup — the database already has the row.
    const serialized = JSON.stringify(payload)
    const notifications: Promise<unknown>[] = [
        dataRedis.publish(SIGNUP_CHANNEL, serialized)
    ]

    if (env.BOT_WORKER_URL && env.BOT_WORKER_SYNC_TOKEN) {
        notifications.push(fetch(`${env.BOT_WORKER_URL.replace(/\/$/, '')}/signup-change`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${env.BOT_WORKER_SYNC_TOKEN}`,
                'content-type': 'application/json'
            },
            body: serialized
        }).then((response) => {
            if (!response.ok) throw new Error(`Bot sync returned ${response.status}`)
        }))
    }

    await Promise.allSettled(notifications)
}
