// Conditional writes cannot recreate a vehicle removed while a solver or import
// was loading its context. Seeds also claim their list entry atomically.
export const ADD_VEHICLE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HSET', KEYS[2], unpack(ARGV, 3))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[1]))
redis.call('LREM', KEYS[3], 0, ARGV[2])
redis.call('RPUSH', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[1]))
return 1
`

export const PATCH_VEHICLE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], unpack(ARGV))
return 1
`

// A tow's validation and publication share the write, so simultaneous claims
// cannot both succeed and readers never see an event before its state exists.
export const MODIFY_VEHICLE = `
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
for field, value in pairs(patch) do redis.call('HSET', KEYS[2], field, value) end
if next(patch) ~= nil then redis.call('PUBLISH', ARGV[4], ARGV[5]) end
return 1
`

// Removing a target and releasing its trucks must exclude concurrent tow
// claims. Publish inside the script so DELETE cannot overtake a newer claim.
export const DELETE_VEHICLES = `
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

export const CLOSE_ROOM = `
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
redis.call('PUBLISH', ARGV[2], '{"event":"CLOSED"}')
return 1
`
