import assert from 'node:assert/strict'
import { dlopen, FFIType, ptr } from 'bun:ffi'
// macOS-only independent check. Unlike V8 sample timeDeltas, these counters
// measure scheduled user/system CPU, excluding network wait and descheduling.
// This includes host workerd overhead and is NOT Cloudflare's billing counter.
assert.equal(process.platform, 'darwin', 'This process CPU counter uses macOS libproc')
const fixture = await Bun.file('/tmp/trptools-engagement-fixture.json').json()
async function pid(port: number) {
    const process = Bun.spawn(['lsof', '-tiTCP:' + port, '-sTCP:LISTEN'], { stdout: 'pipe', stderr: 'ignore' })
    const output = await new Response(process.stdout).text()
    assert.equal(await process.exited, 0)
    const ids = [...new Set(output.trim().split(/\s+/).map(Number))]
    assert.equal(ids.length, 1, 'one isolated workerd process per port')
    return ids[0]!
}
const backendPid = await pid(54002), frontendPid = await pid(54000)
const clock = dlopen('/usr/lib/libSystem.B.dylib', { mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 } })
const timebase = new Uint32Array(2)
assert.equal(clock.symbols.mach_timebase_info(ptr(timebase)), 0)
const nsPerTick = timebase[0]! / timebase[1]!
const lib = dlopen('/usr/lib/libproc.dylib', { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
const buffer = new Uint8Array(256), view = new DataView(buffer.buffer)
function cpu(processId: number) {
    assert.equal(lib.symbols.proc_pid_rusage(processId, 2, ptr(buffer)), 0)
    return view.getBigUint64(16, true) + view.getBigUint64(24, true)
}
// Check the clock conversion against POSIX CPU accounting in this process.
const calibrationBefore = cpu(process.pid), posixBefore = process.cpuUsage()
const spinUntil = performance.now() + 60
while (performance.now() < spinUntil) Math.sqrt(performance.now())
const posixAfter = process.cpuUsage(posixBefore)
const calibration = { counterCpuMs: Number(cpu(process.pid) - calibrationBefore) * nsPerTick / 1e6, posixCpuMs: (posixAfter.user + posixAfter.system) / 1000 }
assert.ok(Math.abs(calibration.counterCpuMs - calibration.posixCpuMs) < Math.max(3, calibration.posixCpuMs * .15), 'Mac clock conversion must agree with POSIX CPU time')
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const baseline = [cpu(backendPid), cpu(frontendPid)]
await sleep(1000)
const idleMsPerSecond = { backend: Number(cpu(backendPid) - baseline[0]!) * nsPerTick / 1e6, frontend: Number(cpu(frontendPid) - baseline[1]!) * nsPerTick / 1e6 }
const { USER_WIDGETS, HOST_WIDGETS } = await import('../src/users/homeLayout')
const layoutResponse = await fetch('http://localhost:54002/users/me/preferences', { method: 'PATCH', headers: { cookie: `access_token=${fixture.token}`, origin: 'http://localhost:54000', 'content-type': 'application/json' }, body: JSON.stringify({ homeLayout: { user: USER_WIDGETS.map(id => ({id, width: 1})), host: HOST_WIDGETS.map(id => ({id, width: 1})) } }) })
assert.equal(layoutResponse.status, 200)
await layoutResponse.arrayBuffer()
const cases = [
    { layer: 'API', operation: 'User homepage', port: 54002, pid: backendPid, path: '/dashboard/home?mode=user' },
    { layer: 'API', operation: 'Host homepage', port: 54002, pid: backendPid, path: '/dashboard/home?mode=host' },
    { layer: 'API', operation: 'Statistics', port: 54002, pid: backendPid, path: '/statistics/groups/' + fixture.groupId },
    { layer: 'SSR', operation: 'User homepage', port: 54000, pid: frontendPid, path: '/?view=user' },
    { layer: 'SSR', operation: 'Host homepage', port: 54000, pid: frontendPid, path: '/?view=host' },
    { layer: 'SSR', operation: 'Statistics', port: 54000, pid: frontendPid, path: '/dashboard/' + fixture.groupSlug + '/statistics' }
]
const results = []
for (const entry of cases) {
    const samplesMs: number[] = [], wallMs: number[] = [], warmupMs: number[] = []
    for (let i = 0; i < 65; i++) {
        const before = cpu(entry.pid), wall = performance.now()
        const response = await fetch(`http://localhost:${entry.port}${entry.path}`, { headers: { cookie: `access_token=${fixture.token}` } })
        await response.arrayBuffer()
        assert.equal(response.status, 200, entry.operation + ' ' + entry.layer)
        const elapsed = Number(cpu(entry.pid) - before) * nsPerTick / 1e6
        if (i >= 15) { samplesMs.push(elapsed); wallMs.push(performance.now() - wall) }
        else warmupMs.push(elapsed)
    }
    const sorted = samplesMs.toSorted((a,b) => a-b)
    const result = { layer: entry.layer, operation: entry.operation, requests: samplesMs.length, firstRequestCpuMs: warmupMs[0], warmupMaxMs: Math.max(...warmupMs), meanMs: samplesMs.reduce((a,b)=>a+b,0)/samplesMs.length,
        medianMs: sorted[Math.floor(sorted.length/2)]!, p95Ms: sorted[Math.ceil(sorted.length*.95)-1]!, maxMs: Math.max(...samplesMs), above10ms: samplesMs.filter(ms=>ms>10).length,
        wallMeanMs: wallMs.reduce((a,b)=>a+b,0)/wallMs.length, samplesMs }
    results.push(result)
    console.log(JSON.stringify({ ...result, samplesMs: undefined }))
}
lib.close()
clock.close()
await Bun.write('/tmp/trptools-page-cpu-results.json', JSON.stringify({ method: 'macOS proc_pid_rusage user+system CPU delta (Mach ticks converted with mach_timebase_info) across each complete HTTP response in isolated local workerd; 15 warmups + 50 measured requests; process overhead included, waits excluded; not Cloudflare billing.', timebase: { numerator: timebase[0], denominator: timebase[1] }, calibration, layouts: { userWidgets: USER_WIDGETS.length, hostWidgets: HOST_WIDGETS.length }, idleMsPerSecond, results }, null, 2))
