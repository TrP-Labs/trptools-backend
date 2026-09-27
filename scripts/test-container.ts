import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const image = process.argv[2]
assert(image, 'Usage: bun run scripts/test-container.ts <image>')
const directory = await mkdtemp(join(tmpdir(), 'trptools-render-'))
// GitHub's runner UID differs from the image's unprivileged Bun user.
await chmod(directory, 0o755)
const entry = fileURLToPath(new URL(`.container-render-${crypto.randomUUID()}.ts`, import.meta.url))
async function command(args: string[]) {
    const proc = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' })
    assert.equal(await proc.exited, 0, `${args[0]} failed`)
}
try {
    // Bundle the real renderer and run from /app, just like the API image.
    await writeFile(entry, `
        import { renderManifest } from '../src/bot/manifest';
        const png = await renderManifest({ groupName: 'Container test', shiftName: 'Test shift',
            vehicles: [], drivers: new Map(), dispatchers: 1, renderedAt: new Date() });
        if (png.length < 100 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
            throw new Error('Renderer did not produce a PNG');
        console.log('Container renderer produced a PNG:', png.length, 'bytes');
        process.exit(0);
    `)
    await command([process.execPath, 'build', entry, '--target', 'bun', '--outdir', directory])
    const bundle = entry.split('/').at(-1)!.replace(/\.ts$/, '.js')
    await command(['docker', 'run', '--rm', '--entrypoint', 'bun',
        '--mount', `type=bind,source=${directory},target=/app/smoke,readonly`,
        '--env', 'DATABASE_URL=postgresql://test:test@127.0.0.1:9/test',
        '--env', 'REDIS_URL=redis://127.0.0.1:9',
        '--env', 'ENCRYPTION_KEY=container-smoke-test-only', image, `smoke/${bundle}`])
    await command(['docker', 'run', '--rm', '--entrypoint', 'bun',
        '--env', 'DATABASE_URL=postgresql://test:test@127.0.0.1:9/test',
        '--env', 'REDIS_URL=redis://127.0.0.1:9',
        '--env', 'ENCRYPTION_KEY=container-smoke-test-only', image, '-e',
        "await import('./dist/index.js'); console.log('Production bundle loaded'); process.exit(0)"])
} finally {
    await rm(entry, { force: true })
    await rm(directory, { recursive: true, force: true })
}
