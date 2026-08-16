/**
 * Font files imported with `{ type: 'file' }` resolve to a path string.
 *
 * Bun's bundler emits the file next to the bundle and rewrites the value, so
 * the same import works from `src` in development and from `dist` in a
 * container.
 */
declare module '*.ttf' {
    const path: string
    export default path
}
