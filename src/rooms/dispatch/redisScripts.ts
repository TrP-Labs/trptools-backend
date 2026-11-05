/**
 * Each vehicle counts the changes to what dispatch is telling its driver in
 * `rev`, which the driver feed (`src/driver/`) hands out as its state index.
 * Only a field that actually changes value counts: the game reports every
 * fifteen seconds and rewrites fields that are already what they say, and a
 * driver polling for news must not be told something changed every time.
 */
export const REVISION = `
local DISPATCHED = {route=true, assigned=true, towing=true, note=true, location=true, status=true, category=true, command=true, order=true}
local function differs(key, field, value)
    return DISPATCHED[field] and (redis.call('HGET', key, field) or '') ~= value
end
local function bump(key)
    if redis.call('EXISTS', key) == 1 then redis.call('HINCRBY', key, 'rev', 1) end
end
`

// Conditional writes cannot recreate a vehicle removed while a solver or import
// was loading its context. Seeds also claim their list entry atomically.
// The driver index lets one person's vehicles be found without walking every
// open room; an entry outliving its vehicle is dropped where it is read.
export const ADD_VEHICLE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HSET', KEYS[2], unpack(ARGV, 3))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
redis.call('LREM', KEYS[3], 0, ARGV[2])
redis.call('RPUSH', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[1]))
local owner
for i = 3, #ARGV, 2 do if ARGV[i] == 'ownerId' then owner = ARGV[i + 1] end end
if owner and owner ~= '' and owner ~= '0' then
    local index = 'driverindex:' .. owner
    redis.call('SADD', index, string.sub(KEYS[1], 6) .. ':' .. ARGV[2])
    redis.call('EXPIRE', index, tonumber(ARGV[1]))
end
return 1
`

export const PATCH_VEHICLE = `${REVISION}
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
local changed = false
for i = 1, #ARGV, 2 do if differs(KEYS[2], ARGV[i], ARGV[i + 1]) then changed = true end end
redis.call('HSET', KEYS[2], unpack(ARGV))
if changed then bump(KEYS[2]) end
return 1
`

// A tow's validation and publication share the write, so simultaneous claims
// cannot both succeed and readers never see an event before its state exists.
export const MODIFY_VEHICLE = `${REVISION}
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return -1 end
local patch = cjson.decode(ARGV[3])
local target = patch.towing
if target and target ~= '' then
    if target == ARGV[1] then return -2 end
    if redis.call('EXISTS', ARGV[2] .. target) == 0 then return -3 end
    for _, id in ipairs(redis.call('LRANGE', KEYS[3], 0, -1)) do
        if id ~= ARGV[1] and redis.call('HGET', ARGV[2] .. id, 'towing') == target then return -4 end
    end
end
local changed = false
for field, value in pairs(patch) do if differs(KEYS[2], field, value) then changed = true end end
-- A tow is news on both ends: the vehicle being pulled is told who by.
if target ~= nil then
    local previous = redis.call('HGET', KEYS[2], 'towing') or ''
    if previous ~= target then
        if previous ~= '' then bump(ARGV[2] .. previous) end
        if target ~= '' then bump(ARGV[2] .. target) end
    end
end
for field, value in pairs(patch) do redis.call('HSET', KEYS[2], field, value) end
if changed then bump(KEYS[2]) end
if next(patch) ~= nil then redis.call('PUBLISH', ARGV[4], ARGV[5]) end
return 1
`

// Removing a target and releasing its trucks must exclude concurrent tow
// claims. Publish inside the script so DELETE cannot overtake a newer claim.
export const DELETE_VEHICLES = `${REVISION}
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local gone = {}
local removed = 0
for _, id in ipairs(cjson.decode(ARGV[2])) do
    if redis.call('LREM', KEYS[2], 0, id) > 0 then
        redis.call('DEL', ARGV[1] .. id)
        gone[id] = true
        removed = removed + 1
        redis.call('PUBLISH', ARGV[3], cjson.encode({event='DELETE', data=id}))
    end
end
if removed > 0 then
    for _, id in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
        local key = ARGV[1] .. id
        local target = redis.call('HGET', key, 'towing')
        if target and gone[target] then
            redis.call('HSET', key, 'towing', '')
            bump(key)
            redis.call('PUBLISH', ARGV[3], cjson.encode({event='UPDATE', data={id=id, towing=cjson.null}}))
        end
    end
end
return removed
`

// The zero-count removal belongs to the increment: a reconnect between them
// must not lose its presence. Closing a room must not leave new presence keys.
export const CHANGE_PRESENCE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {} end
local count = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
count = math.max(0, count + tonumber(ARGV[2]))
if count == 0 then
    redis.call('HDEL', KEYS[2], ARGV[1])
else
    redis.call('HSET', KEYS[2], ARGV[1], count)
    redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
end
local fields = redis.call('HGETALL', KEYS[2])
local present = {}
for i = 1, #fields, 2 do
    if tonumber(fields[i + 1]) > 0 then table.insert(present, fields[i]) end
end
local encoded = #present == 0 and '[]' or cjson.encode(present)
redis.call('PUBLISH', ARGV[4], '{"event":"PRESENCE","data":' .. encoded .. '}')
return present
`

// A whole board in one call. Reading it as one HGETALL per vehicle cost a
// request for every vehicle on every game report, board load and stream
// sync — by far the largest share of the Redis requests a live shift made.
// KEYS: the room's vehicle list. ARGV: the vehicle key prefix.
// Returns { ids, { field, value, ... } per id }.
export const LOAD_VEHICLES = `
local ids = redis.call('LRANGE', KEYS[1], 0, -1)
local hashes = {}
for i, id in ipairs(ids) do hashes[i] = redis.call('HGETALL', ARGV[1] .. id) end
return {ids, hashes}
`
