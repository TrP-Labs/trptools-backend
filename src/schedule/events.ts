import { dataRedis } from '../utils/redis'

/**
 * The channel the Discord bot listens on for sign-up changes made on the web.
 *
 * Redis pub/sub is already how dispatch fans out, and reusing it here means
 * the API never has to know whether a bot process exists, let alone reach it.
 * A message sent with nobody subscribed is simply dropped, which is the right
 * behaviour when a group has no bot connected.
 */
export const SIGNUP_CHANNEL = 'bot.signup'

export type SignupChange = {
    groupId: string
    eventId: string
    /** ISO 8601, milliseconds preserved. */
    occurrence: string
    /** The sheet that changed, so the bot edits one message rather than all. */
    signupId: string
}

export async function publishSignupChange(
    groupId: string,
    eventId: string,
    occurrence: Date,
    signupId: string
) {
    const payload: SignupChange = {
        groupId,
        eventId,
        // `toISOString` rather than `String(date)`, which drops milliseconds
        // and would land the bot on an occurrence that matches nothing.
        occurrence: occurrence.toISOString(),
        signupId
    }

    // Fan-out is best effort. A dropped notification costs a stale embed until
    // the next edit, never a lost signup — the database already has the row.
    await dataRedis.publish(SIGNUP_CHANNEL, JSON.stringify(payload)).catch(() => undefined)
}
