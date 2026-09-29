import { status } from 'elysia'
import { and, eq, ne } from 'drizzle-orm'
import db from '../db'
import { groupFollows, groups } from '../db/schema'
import { summarise } from '../groups/service'
import { requireUser } from '../utils/authPlugin'
import { NON_MEMBER } from '../utils/membershipRule'
import type { session } from '../utils/sessionVerifier'
import { databaseLimitReached } from '../utils/databaseLimit'

export abstract class Follows {
    static async list(session: session) {
        const user = requireUser(session)
        const rows = await db.select({ group: groups }).from(groupFollows)
            .innerJoin(groups, eq(groups.id, groupFollows.groupId))
            .where(and(eq(groupFollows.userId, user.userId), ne(groups.visibility, 'PRIVATE'), ne(groups.moderation, 'HIDDEN')))
            .orderBy(groupFollows.createdAt).limit(100)
        // Following is a reading preference. It never grants group permissions.
        return rows.map(({ group }) => summarise(group, NON_MEMBER))
    }

    static async set(groupId: string, following: boolean, session: session) {
        const user = requireUser(session)
        if (!following) {
            await db.delete(groupFollows).where(and(eq(groupFollows.userId, user.userId), eq(groupFollows.groupId, groupId)))
            return 'Success' as const
        }
        const [group] = await db.select({ id: groups.id }).from(groups)
            .where(and(eq(groups.id, groupId), ne(groups.visibility, 'PRIVATE'), ne(groups.moderation, 'HIDDEN'))).limit(1)
        if (!group) throw status(404, 'Not Found')
        try {
            await db.insert(groupFollows).values({ userId: user.userId, groupId }).onConflictDoNothing()
        } catch (error) {
            if (databaseLimitReached(error, 'follow limit')) throw status(409, 'Conflict')
            throw error
        }
        return 'Success' as const
    }
}
