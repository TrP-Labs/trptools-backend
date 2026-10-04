import { expect, test } from 'bun:test'

test('production refuses the public development encryption key', () => {
    const run = (key: string) => Bun.spawnSync([process.execPath, '--no-env-file', '--eval',
        `await import(${JSON.stringify(import.meta.dir + '/env.ts')})`], {
        env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://unused@127.0.0.1:9/unused', ENCRYPTION_KEY: key },
        stdout: 'pipe', stderr: 'pipe'
    })
    for (const key of ['', 'trptools-development-encryption-key']) {
        const result = run(key)
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr.toString()).toContain('Set a private ENCRYPTION_KEY')
    }
    expect(run('independent-test-encryption-key-material').exitCode).toBe(0)
})
