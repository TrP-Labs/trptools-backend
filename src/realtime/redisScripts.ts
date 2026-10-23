// A newer command replaces any queued one answering the same question, and
// marks the vehicle in the same step, so the board can never show "queued"
// for a command that is not in the queue (or the reverse).
// KEYS: room, queue, vehicle. ARGV: key, entry, ttl, channel, vehicleId, assignment
export const ENQUEUE_COMMAND = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then return -1 end
for _, raw in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
    local ok, entry = pcall(cjson.decode, raw)
    if not ok or entry.key == ARGV[1] then redis.call('LREM', KEYS[2], 0, raw) end
end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('LTRIM', KEYS[2], -200, -1)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
if ARGV[6] == '1' then
    redis.call('HSET', KEYS[3], 'command', 'QUEUED')
    redis.call('PUBLISH', ARGV[4], cjson.encode({event='UPDATE', data={id=ARGV[5], command='QUEUED'}}))
end
return 1
`

// Takes what one response may carry and marks those vehicles as sent: the
// board shows them waiting until the game's next report says what it did.
// KEYS: room, queue. ARGV: vehicle key prefix, channel, limit
export const DRAIN_COMMANDS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {} end
local limit = tonumber(ARGV[3])
local taken = redis.call('LRANGE', KEYS[2], 0, limit - 1)
if #taken == 0 then return {} end
redis.call('LTRIM', KEYS[2], #taken, -1)
for _, raw in ipairs(taken) do
    local ok, entry = pcall(cjson.decode, raw)
    if ok and entry.assignment then
        local id = tostring(entry.command.Vehicle)
        local key = ARGV[1] .. id
        if redis.call('HGET', key, 'command') == 'QUEUED' then
            redis.call('HSET', key, 'command', 'SENT')
            redis.call('PUBLISH', ARGV[2], cjson.encode({event='UPDATE', data={id=id, command='SENT'}}))
        end
    end
end
return taken
`

// Credits everybody present in one step, and reports whether enough time has
// passed since the last write-through to Postgres to make another.
// KEYS: seconds hash. ARGV: now, step seconds, flush every ms, ttl, final, ids...
export const RECORD_ATTENDANCE = `
local step = tonumber(ARGV[2])
if step > 0 then
    for i = 6, #ARGV do redis.call('HINCRBY', KEYS[1], ARGV[i], step) end
end
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
local flushed = tonumber(redis.call('HGET', KEYS[1], '__flushedAt') or '0')
if flushed < 0 then return 0 end
if ARGV[5] == '1' or tonumber(ARGV[1]) - flushed >= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], '__flushedAt', ARGV[5] == '1' and '-1' or ARGV[1])
    return 1
end
return 0
`
