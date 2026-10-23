/**
 * Everything a room owns, removed in one step.
 *
 * Expiry alone left the vehicles, presence and command queue behind for hours
 * after the room hash itself had gone, because each carried its own longer
 * TTL. Shared by every path that ends a room so none of them can forget a key.
 */
const DROP_ROOM = `
local function dropRoom(roomId, group)
    local prefix = 'dispatchroom:' .. roomId
    for _, id in ipairs(redis.call('LRANGE', prefix .. ':vehicles', 0, -1)) do redis.call('DEL', prefix .. ':vehicles:' .. id) end
    redis.call('DEL', 'room:' .. roomId, prefix .. ':vehicles', prefix .. ':users', prefix .. ':commands')
    if group and redis.call('GET', 'groupindex:' .. group) == roomId then redis.call('DEL', 'groupindex:' .. group) end
    redis.call('PUBLISH', 'dispatchroom.' .. roomId, '{"event":"CLOSED"}')
end
`

/**
 * Reads a room, closing it if its shift and wrap-up are over.
 *
 * A room used to stay open for as long as anybody had a tab on it, extended
 * two hours at a time, and a presence count left behind by a crashed stream
 * kept it open indefinitely — holding the group's one room and every key
 * under it. The end of wrap-up (`activeUntil`) is now the end, connected or
 * not; a host who needs longer extends the shift, which moves it.
 */
export const TOUCH_ROOM = `${DROP_ROOM}
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local active = tonumber(redis.call('HGET', KEYS[1], 'activeUntil') or '0')
if active == 0 then active = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0') + 1800000 end
local group = redis.call('HGET', KEYS[1], 'groupId')
if tonumber(ARGV[1]) >= active then
    dropRoom(ARGV[2], group)
    return 0
end
local ttl = math.max(1, math.ceil((active - tonumber(ARGV[1])) / 1000) + 60)
redis.call('EXPIRE', KEYS[1], ttl)
if group then redis.call('EXPIRE', 'groupindex:' .. group, ttl) end
return 1
`

export const CLOSE_ROOM = `${DROP_ROOM}
dropRoom(ARGV[1], redis.call('HGET', KEYS[1], 'groupId'))
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
