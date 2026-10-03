import { neonConfig } from '@neondatabase/serverless'
// A local SQL gateway lets workerd exercise the same Neon transport against
// the isolated Postgres fixture. This entry is never deployed.
neonConfig.fetchEndpoint = 'http://127.0.0.1:56490/sql'
const entry = (await import('../src/worker')).default
export default entry
