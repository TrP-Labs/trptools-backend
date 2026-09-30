import { env } from '../utils/env'
import { timingSafeEqual } from '../utils/crypto'
export function authorizedBackgroundJob(request: Request) {
    if (!env.BACKGROUND_JOB_TOKEN || !new URL(request.url).pathname.startsWith('/background/')) return false
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    return timingSafeEqual(bearer, env.BACKGROUND_JOB_TOKEN)
}
