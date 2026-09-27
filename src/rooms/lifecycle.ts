// Expiry is a crash fallback. A connected host keeps the room available after
// wrap-up; the last departure closes it atomically with presence removal.
export const TOUCH_ROOM = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local active = tonumber(redis.call('HGET', KEYS[1], 'activeUntil') or '0')
if active == 0 then active = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0') + 1800000 end
local group = redis.call('HGET', KEYS[1], 'groupId')
if tonumber(ARGV[1]) >= active and redis.call('HLEN', KEYS[2]) == 0 then
    redis.call('DEL', KEYS[1])
    if redis.call('GET', 'groupindex:' .. group) == ARGV[2] then redis.call('DEL', 'groupindex:' .. group) end
    redis.call('PUBLISH', ARGV[3], '{"event":"CLOSED"}')
    return 0
end
local occupied = redis.call('HLEN', KEYS[2]) > 0
local ttl = math.max(1, math.ceil((active - tonumber(ARGV[1])) / 1000))
if occupied then ttl = math.max(7200, ttl + 7200) end
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', 'groupindex:' .. group, ttl)
return 1
`

export const CREATE_ROOM = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local info = cjson.decode(ARGV[2])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
for key, value in pairs(info) do redis.call('HSET', KEYS[1], key, value) end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`
