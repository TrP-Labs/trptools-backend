import { runNotificationTick } from '../notifications/scheduler'
export function startBackgroundRunner() {
    let running = false
    const tick = async () => {
        if (running) return
        running = true
        try {
            await runNotificationTick(async (kind, id) => {
                if (kind === 'plan') {
                    const { planNotification } = await import('../notifications/scheduler')
                    await planNotification(id)
                } else {
                    const { deliverNotification } = await import('../notifications/delivery')
                    await deliverNotification(id)
                }
            })
        } catch (error) { console.error('[background] tick failed', error instanceof Error ? error.message : 'unknown') }
        finally { running = false }
    }
    const timer = setInterval(() => void tick(), 60_000)
    timer.unref()
    void tick()
    return () => clearInterval(timer)
}
