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
    redis.call('SREM', 'rooms:open', roomId)
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
/**
 * Keeps a room alive until the end of its wrap-up and closes it after.
 * A function, so the game feed's report script can touch the room in the
 * same call that reads it.
 */
export const TOUCH_FUNCTION = `${DROP_ROOM}
local function touchRoom(roomId, now)
    local key = 'room:' .. roomId
    if redis.call('EXISTS', key) == 0 then
        -- Expired without being closed; nothing is left to drop but the entry.
        redis.call('SREM', 'rooms:open', roomId)
        return false
    end
    local active = tonumber(redis.call('HGET', key, 'activeUntil') or '0')
    if active == 0 then active = tonumber(redis.call('HGET', key, 'expiresAt') or '0') + 1800000 end
    local group = redis.call('HGET', key, 'groupId')
    if now >= active then
        dropRoom(roomId, group)
        return false
    end
    local ttl = math.max(1, math.ceil((active - now) / 1000) + 60)
    redis.call('EXPIRE', key, ttl)
    if group then redis.call('EXPIRE', 'groupindex:' .. group, ttl) end
    return true
end
`

export const TOUCH_ROOM = `${TOUCH_FUNCTION}
return touchRoom(ARGV[2], tonumber(ARGV[1])) and 1 or 0
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
redis.call('SADD', 'rooms:open', ARGV[1])
return 1
`

/**
 * What the minute sweep does for one room: keep it alive or close it, then
 * move its timeline along the clock (publishing HOST when a card changes).
 * One request per room, where touching and settling were two.
 * KEYS: the room. ARGV: now, room id, channel, 'SETTLE'.
 */
export const sweepRoomScript = (claimTimeline: string) => `${TOUCH_FUNCTION}
if not touchRoom(ARGV[2], tonumber(ARGV[1])) then return 0 end
${claimTimeline}`

/**
 * The open rooms, from the set CREATE_ROOM and DROP_ROOM keep. The first
 * sweep after this shipped fills it from the group index once, so a room
 * opened by the previous build is still swept; the marker stops every later
 * sweep from walking the keyspace again.
 * Returns the room ids, or false when the backfill is still to be done.
 */
export const OPEN_ROOMS = `
if redis.call('EXISTS', 'rooms:open:indexed') == 0 then return false end
return redis.call('SMEMBERS', 'rooms:open')
`
export const BACKFILL_OPEN_ROOMS = `
for _, id in ipairs(ARGV) do redis.call('SADD', 'rooms:open', id) end
redis.call('SET', 'rooms:open:indexed', '1')
return redis.call('SMEMBERS', 'rooms:open')
`
