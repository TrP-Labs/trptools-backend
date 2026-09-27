/** Keep asynchronous disconnect cleanup alive after a Worker request is canceled. */
type Lifetime = { waitUntil(promise: Promise<unknown>): void }
const lifetimes = new WeakMap<Request, Lifetime>()
export function registerRequestLifetime(request: Request, lifetime: Lifetime) {
    lifetimes.set(request, lifetime)
}
export function finishRequestCleanup(
    request: Request,
    promise: Promise<unknown>,
) {
    lifetimes.get(request)?.waitUntil(promise)
}
