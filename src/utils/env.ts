function required(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`Missing required environment variable: ${name}`)
    return value
}

function optional(name: string, fallback: string): string {
    return process.env[name] || fallback
}

function stripTrailingSlash(value: string) {
    return value.endsWith('/') ? value.slice(0, -1) : value
}

const NODE_ENV = optional('NODE_ENV', 'development')

export const env = {
    NODE_ENV,
    isProduction: NODE_ENV === 'production',

    PORT: Number(optional('PORT', '3001')),
    HOST: optional('HOST', '0.0.0.0'),

    DATABASE_URL: required('DATABASE_URL'),
    REDIS_URL: optional('REDIS_URL', 'redis://localhost:6379'),

    /** Public origin of this API, used to build the OAuth redirect URI. */
    BASE_URL: stripTrailingSlash(optional('BASE_URL', 'http://localhost:3001')),

    /**
     * Comma separated list of browser origins allowed to talk to this API with
     * credentials. The first entry is where OAuth lands the user afterwards.
     */
    FRONTEND_URLS: optional('FRONTEND_URL', 'http://localhost:5173')
        .split(',')
        .map((value) => stripTrailingSlash(value.trim()))
        .filter(Boolean),

    ROBLOX_CLIENT_ID: optional('ROBLOX_CLIENT_ID', ''),
    ROBLOX_CLIENT_SECRET: optional('ROBLOX_CLIENT_SECRET', ''),

    /**
     * Optional instance-wide Open Cloud API key. Used as the last resort before
     * the legacy endpoints when a group has not supplied its own key.
     */
    ROBLOX_API_KEY: optional('ROBLOX_API_KEY', ''),

    /** Key material for AES-GCM encryption of stored OAuth tokens and API keys. */
    ENCRYPTION_KEY: optional('ENCRYPTION_KEY', 'trptools-development-encryption-key'),

    // --- S3-compatible object storage for uploaded images -------------------
    S3_ENDPOINT: stripTrailingSlash(optional('S3_ENDPOINT', 'http://localhost:9000')),
    /** Browser-facing base URL, when it differs from the internal endpoint. */
    S3_PUBLIC_URL: stripTrailingSlash(optional('S3_PUBLIC_URL', '')),
    S3_BUCKET: optional('S3_BUCKET', 'trptools'),
    S3_ACCESS_KEY: optional('S3_ACCESS_KEY', ''),
    S3_SECRET_KEY: optional('S3_SECRET_KEY', ''),
    S3_REGION: optional('S3_REGION', 'us-east-1'),

    /** Cookies are only marked Secure when the API is served over https. */
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || undefined,

    SESSION_TTL_DAYS: Number(optional('SESSION_TTL_DAYS', '30')),

    /** Comma separated Roblox user ids granted the `admin` site rank on login. */
    SITE_ADMINS: optional('SITE_ADMINS', '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
}

export const FRONTEND_URL = env.FRONTEND_URLS[0] ?? 'http://localhost:5173'

export const cookieSecure = env.BASE_URL.startsWith('https://')

export const robloxConfigured = Boolean(env.ROBLOX_CLIENT_ID && env.ROBLOX_CLIENT_SECRET)

if (env.isProduction && env.ENCRYPTION_KEY === 'trptools-development-encryption-key') {
    console.warn('[env] ENCRYPTION_KEY is unset — stored Roblox tokens are not protected. Set it before going live.')
}
