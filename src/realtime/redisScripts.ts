import { REVISION } from '../rooms/dispatch/redisScripts'
import { TOUCH_FUNCTION } from '../rooms/lifecycle'

// A newer command replaces any queued one answering the same question, and
// marks the vehicle in the same step, so the board can never show "queued"
// for a command that is not in the queue (or the reverse).
// KEYS: room, queue, vehicle. ARGV: key, entry, ttl, channel, vehicleId, assignment
// ARGV[7] is the standing order a stop, continue or end of shift leaves the
// driver with, and ARGV[8] when it was given; both empty for a route or tow.
export const ENQUEUE_COMMAND = `${REVISION}
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then return -1 end
for _, raw in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
    local ok, entry = pcall(cjson.decode, raw)
    if not ok or entry.key == ARGV[1] then redis.call('LREM', KEYS[2], 0, raw) end
end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('LTRIM', KEYS[2], -200, -1)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
if ARGV[7] ~= '' then
    if differs(KEYS[3], 'order', ARGV[7]) then bump(KEYS[3]) end
    redis.call('HSET', KEYS[3], 'order', ARGV[7], 'orderAt', ARGV[8])
elseif ARGV[6] == '1' and redis.call('HGET', KEYS[3], 'order') == 'END_SHIFT' then
    -- A new route after an end of shift takes the driver back on.
    redis.call('HSET', KEYS[3], 'order', '')
    bump(KEYS[3])
end
if ARGV[6] == '1' then
    if differs(KEYS[3], 'command', 'QUEUED') then bump(KEYS[3]) end
    redis.call('HSET', KEYS[3], 'command', 'QUEUED')
    redis.call('PUBLISH', ARGV[4], cjson.encode({event='UPDATE', data={id=ARGV[5], command='QUEUED'}}))
end
return 1
`

// Takes what one response may carry and marks those vehicles as sent: the
// board shows them waiting until the game's next report says what it did.
// KEYS: room, queue. ARGV: vehicle key prefix, channel, limit.
// Returns { commands taken, commands still queued }.
export const DRAIN_COMMANDS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {{}, 0} end
local limit = tonumber(ARGV[3])
local taken = redis.call('LRANGE', KEYS[2], 0, limit - 1)
if #taken == 0 then return {{}, 0} end
redis.call('LTRIM', KEYS[2], #taken, -1)
for _, raw in ipairs(taken) do
    local ok, entry = pcall(cjson.decode, raw)
    if ok and entry.assignment then
        local id = tostring(entry.command.Vehicle)
        local key = ARGV[1] .. id
        if redis.call('HGET', key, 'command') == 'QUEUED' then
            redis.call('HSET', key, 'command', 'SENT')
            redis.call('HINCRBY', key, 'rev', 1)
            redis.call('PUBLISH', ARGV[2], cjson.encode({event='UPDATE', data={id=id, command='SENT'}}))
        end
    end
end
-- What is left, so the report can say so without asking again.
return {taken, redis.call('LLEN', KEYS[2])}
`

// Credits everybody present in one step, with their names and the jobs they
// held, and reports whether enough time has passed since the last
// write-through to Postgres to make another. Five requests a report before.
// KEYS: seconds hash, names hash, jobs hash.
// ARGV: now, step seconds, flush every ms, ttl, final, names JSON, jobs JSON, ids...
export const RECORD_ATTENDANCE = `
local step = tonumber(ARGV[2])
local ttl = tonumber(ARGV[4])
if step > 0 then
    for i = 8, #ARGV do redis.call('HINCRBY', KEYS[1], ARGV[i], step) end
    if #ARGV >= 8 then
        for id, name in pairs(cjson.decode(ARGV[6])) do redis.call('HSET', KEYS[2], id, name) end
        redis.call('EXPIRE', KEYS[2], ttl)
    end
    local jobs = cjson.decode(ARGV[7])
    if next(jobs) ~= nil then
        for field, value in pairs(jobs) do redis.call('HSET', KEYS[3], field, value) end
        redis.call('EXPIRE', KEYS[3], ttl)
    end
end
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ttl)
local flushed = tonumber(redis.call('HGET', KEYS[1], '__flushedAt') or '0')
if flushed < 0 then return 0 end
if ARGV[5] == '1' or tonumber(ARGV[1]) - flushed >= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], '__flushedAt', ARGV[5] == '1' and '-1' or ARGV[1])
    return 1
end
return 0
`

// Moves a clock forward and answers with where it was, in one request.
export const ADVANCE_CLOCK = `
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return previous
`

// Everything a report does before it looks at vehicles: the feed's status and
// last snapshot, the group's open room kept alive (or closed, past its
// wrap-up), the game's fields on it, and the room as it now stands. One
// request where there were seven.
// KEYS: feed status, feed snapshot, group index.
// ARGV: now, status ttl, snapshot ttl, snapshot JSON, status fields JSON, room fields JSON.
// Returns false with no room, or { roomId, { field, value, ... } }.
export const REPORT = `${TOUCH_FUNCTION}
local now = tonumber(ARGV[1])
for field, value in pairs(cjson.decode(ARGV[5])) do redis.call('HSET', KEYS[1], field, value) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('SET', KEYS[2], ARGV[4], 'EX', tonumber(ARGV[3]))
local roomId = redis.call('GET', KEYS[3])
if not roomId or not touchRoom(roomId, now) then return false end
for field, value in pairs(cjson.decode(ARGV[6])) do redis.call('HSET', 'room:' .. roomId, field, value) end
return {roomId, redis.call('HGETALL', 'room:' .. roomId)}
`
