import { status } from 'elysia'
import { and, desc, eq } from 'drizzle-orm'
import db from '../db'
import { stagePrograms } from '../db/schema'
import { globalModel } from '../utils/globalModel'
import type { session } from '../utils/sessionVerifier'
import { ToolsModel } from './model'

function parseProgram(raw: string): ToolsModel.program {
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? (parsed as ToolsModel.program) : []
    } catch {
        return []
    }
}

export abstract class StagePrograms {
    static async list(session: session): Promise<ToolsModel.stageProgramList> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const rows = await db
            .select()
            .from(stagePrograms)
            .where(eq(stagePrograms.authorId, session.user.userId))
            .orderBy(desc(stagePrograms.updatedAt))

        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            soundId: row.soundId,
            markers: parseProgram(row.program).length,
            visibility: row.visibility,
            updatedAt: row.updatedAt
        }))
    }

    static async get(id: string, session: session): Promise<ToolsModel.stageProgram> {
        const [row] = await db.select().from(stagePrograms).where(eq(stagePrograms.id, id)).limit(1)
        if (!row) throw status(404, 'Not Found' satisfies globalModel.notFound)

        const isAuthor = session.user?.userId === row.authorId
        if (row.visibility === 'PRIVATE' && !isAuthor && session.user?.siteRank !== 'admin') {
            throw status(404, 'Not Found' satisfies globalModel.notFound)
        }

        return {
            id: row.id,
            name: row.name,
            soundId: row.soundId,
            program: parseProgram(row.program),
            visibility: row.visibility,
            authorId: row.authorId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        }
    }

    static async create(body: ToolsModel.createBody, session: session): Promise<ToolsModel.createResponse> {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const owned = await db
            .select({ id: stagePrograms.id })
            .from(stagePrograms)
            .where(eq(stagePrograms.authorId, session.user.userId))

        if (owned.length >= 100) throw status(409, 'Conflict' satisfies globalModel.conflict)

        const [row] = await db
            .insert(stagePrograms)
            .values({
                authorId: session.user.userId,
                name: body.name,
                soundId: body.soundId ?? null,
                program: JSON.stringify(body.program),
                visibility: body.visibility ?? 'PRIVATE'
            })
            .returning({ id: stagePrograms.id })

        if (!row) throw status(500, 'Internal Server Error' satisfies globalModel.internalError)

        return { id: row.id }
    }

    static async update(id: string, body: ToolsModel.updateBody, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const [row] = await db.select().from(stagePrograms).where(eq(stagePrograms.id, id)).limit(1)
        if (!row) throw status(404, 'Not Found' satisfies globalModel.notFound)
        if (row.authorId !== session.user.userId && session.user.siteRank !== 'admin') {
            throw status(403, 'Forbidden' satisfies globalModel.forbidden)
        }

        const { program, ...rest } = body

        await db
            .update(stagePrograms)
            .set({
                ...rest,
                ...(program !== undefined ? { program: JSON.stringify(program) } : {}),
                updatedAt: new Date()
            })
            .where(eq(stagePrograms.id, id))

        return 'Success' as globalModel.genericSuccess
    }

    static async remove(id: string, session: session) {
        if (!session.user) throw status(401, 'Unauthorized' satisfies globalModel.unauthorized)

        const deleted = await db
            .delete(stagePrograms)
            .where(and(eq(stagePrograms.id, id), eq(stagePrograms.authorId, session.user.userId)))
            .returning({ id: stagePrograms.id })

        if (deleted.length === 0) throw status(404, 'Not Found' satisfies globalModel.notFound)

        return 'Success' as globalModel.genericSuccess
    }
}
