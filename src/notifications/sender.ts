import webpush from 'web-push'
import { env } from '../utils/env'
import type { NotificationModel } from './model'

export function buildPushRequest(subscription: NotificationModel.subscription, message: unknown) {
    return webpush.generateRequestDetails(subscription, JSON.stringify(message), {
        vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
        contentEncoding: 'aes128gcm', TTL: 900, urgency: 'normal'
    })
}

export async function sendPush(subscription: NotificationModel.subscription, message: unknown) {
    const details = buildPushRequest(subscription, message)
    return fetch(details.endpoint, { method: 'POST', headers: details.headers as Record<string, string>,
        body: Uint8Array.from(details.body).buffer, redirect: 'error', signal: AbortSignal.timeout(10_000) })
}
