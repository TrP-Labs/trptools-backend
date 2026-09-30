import webpush from 'web-push'
const keys = webpush.generateVAPIDKeys()
const child = Bun.spawn({ cmd: [process.execPath, 'x', 'wrangler', 'dev', 'scripts/engagement-worker-entry.ts', '--port', '54002', '--inspector-port', '54102',
    '--var', 'DATABASE_URL:postgresql://trptools:trptools@localhost:5432/trptools_engagement_test',
    '--var', 'UPSTASH_REDIS_REST_URL:http://127.0.0.1:54490', '--var', 'UPSTASH_REDIS_REST_TOKEN:engagement-fixture',
    '--var', 'ENCRYPTION_KEY:local-engagement-fixture-key', '--var', 'FRONTEND_URL:http://localhost:54000', '--var', 'BASE_URL:http://localhost:54002',
    '--var', 'BACKGROUND_JOB_TOKEN:engagement-local-test-only', '--var', 'VAPID_PUBLIC_KEY:' + keys.publicKey, '--var', 'VAPID_PRIVATE_KEY:' + keys.privateKey, '--var', 'VAPID_SUBJECT:mailto:test@example.com'],
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_LOG_PATH: '/tmp/trptools-engagement-worker.log' }, stdout: 'inherit', stderr: 'inherit' })
process.on('SIGINT', () => child.kill())
await child.exited
