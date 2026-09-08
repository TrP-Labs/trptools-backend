import { eq, inArray, or, type SQL } from 'drizzle-orm'
import db from '../db'
import { shiftSignups, users } from '../db/schema'

/**
 * Who a sign-up belongs to, across both of the ways one can be made.
 *
 * A row identifies its taker by TrPTools user id *or* by Discord id, never
 * both (see `db/schema/signups.ts`), and the same person can arrive holding
 * either — somebody who filled a Discord sheet before connecting their account
 * leaves a row behind carrying only the Discord id. Every surface that asks
 * "does this person already hold a slot" has to ask it of both columns, or the
 * two halves each see half the sheet and somebody ends up on the shift twice.
 *
 * This is the one place that answers it. The website endpoint, the bot's
 * internal endpoint and the account link all resolve an actor through here so
 * they cannot drift apart.
 */
export type SignupActor = {
    /** Their TrPTools account, when the action came from somebody signed in. */
    userId: string | null
    /** Their Discord account — linked to the above, or standing on its own. */
    discordUserId: string | null
}

/** A stored sign-up, as the ownership test needs to see it. */
type IdentityRow = { userId: string | null; discordUserId: string | null }

/**
 * Whether one stored sign-up was made by this person.
 *
 * Deliberately not a comparison against the identity that would be *written*
 * now: the question is about a row that already exists, which may have been
 * written under the other half of the same person.
 */
export function ownsSignup(row: IdentityRow, actor: SignupActor): boolean {
    if (actor.userId && row.userId === actor.userId) return true
    if (actor.discordUserId && row.discordUserId === actor.discordUserId) return true
    return false
}

/**
 * The same test as a `where` clause, for a delete that never loads the rows.
 *
 * Null for an actor that is neither half — impossible for anybody who could
 * have signed up, but a missing clause would delete the whole table, so the
 * callers check rather than trust.
 */
export function ownedBy(actor: SignupActor): SQL | null {
    const clauses: SQL[] = []
    if (actor.userId) clauses.push(eq(shiftSignups.userId, actor.userId))
    if (actor.discordUserId) clauses.push(eq(shiftSignups.discordUserId, actor.discordUserId))

    if (clauses.length === 0) return null
    return clauses.length === 1 ? clauses[0]! : or(...clauses)!
}

/**
 * How a new row should record this person.
 *
 * The account wins whenever there is one, so a sign-up made from a Discord
 * sheet by somebody who has connected their account is stored against the
 * account — and both halves resolve to one person without going back through
 * `discord_id` on every read.
 */
export function identityFor(actor: SignupActor, discordUsername: string | null) {
    return actor.userId
        ? { userId: actor.userId, discordUserId: null, discordUsername: null }
        : { userId: null, discordUserId: actor.discordUserId, discordUsername }
}

/** The actor behind a signed-in caller, including the Discord half if linked. */
export async function actorForUser(userId: string): Promise<SignupActor> {
    const [account] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)

    return { userId, discordUserId: account?.discordId ?? null }
}

/** The actor behind a Discord interaction, including the account if linked. */
export async function actorForDiscord(discordUserId: string): Promise<SignupActor> {
    const [linked] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.discordId, discordUserId))
        .limit(1)

    return { userId: linked?.id ?? null, discordUserId }
}

/**
 * Moves a Discord account's sign-ups onto the TrPTools account it has just
 * been connected to.
 *
 * Without this, connecting an account leaves every slot already taken from a
 * Discord sheet behind under the old identity: the website would not offer to
 * withdraw from it, and the next sign-up — made under the account — would be a
 * second row for the same person on the same shift. Adopting them at the
 * moment of linking is what makes "one person, one slot" true from then on,
 * rather than something every caller has to keep working around.
 *
 * The Discord sheet renders identically either way — a row carrying the
 * account still mentions the linked Discord id — so nothing needs redrawing.
 *
 * Two rows for the *same* slot collapse into one, since they are the same
 * commitment recorded twice. Two rows for **different** slots on one
 * occurrence are both kept, even though nothing could take them that way now:
 * they were each signed up for deliberately, at a time when neither half knew
 * about the other, and quietly withdrawing somebody from a shift is worse than
 * a duplicate they can now see and give up. The website shows both as theirs
 * from this point on, which it could not do before.
 */
export async function adoptDiscordSignups(userId: string, discordUserId: string): Promise<number> {
    return db.transaction(async (tx) => {
        const mine = await tx
            .select({
                id: shiftSignups.id,
                slotId: shiftSignups.slotId,
                eventId: shiftSignups.eventId,
                occurrence: shiftSignups.occurrence,
                userId: shiftSignups.userId,
                discordUserId: shiftSignups.discordUserId
            })
            .from(shiftSignups)
            .where(or(eq(shiftSignups.userId, userId), eq(shiftSignups.discordUserId, discordUserId))!)

        const key = (row: { slotId: string; eventId: string; occurrence: Date }) =>
            `${row.eventId}:${row.occurrence.getTime()}:${row.slotId}`

        const alreadyHeld = new Set(mine.filter((row) => row.userId === userId).map(key))

        // Signed up on both halves for the same slot: two rows, and the
        // partial unique index would refuse the update. The Discord one goes —
        // the account row is the identity being kept.
        const collided = mine
            .filter((row) => row.discordUserId === discordUserId && alreadyHeld.has(key(row)))
            .map((row) => row.id)

        if (collided.length > 0) {
            await tx.delete(shiftSignups).where(inArray(shiftSignups.id, collided))
        }

        const adopted = mine
            .filter((row) => row.discordUserId === discordUserId && !alreadyHeld.has(key(row)))
            .map((row) => row.id)

        if (adopted.length === 0) return 0

        await tx
            .update(shiftSignups)
            .set({ userId, discordUserId: null, discordUsername: null })
            .where(inArray(shiftSignups.id, adopted))

        return adopted.length
    })
}
