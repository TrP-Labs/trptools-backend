// Rendering time is deliberately absent: an unchanged board keeps the time
// of its last actual render rather than forcing a new image every tick.
export async function manifestVersion(data: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))
    return `W/"manifest-v1-${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}"`
}

export function matchesManifestVersion(header: string | null, etag: string): boolean {
    return header?.split(',').some((value) => value.trim().replace(/^W\//, '') === etag.replace(/^W\//, '') || value.trim() === '*') ?? false
}
