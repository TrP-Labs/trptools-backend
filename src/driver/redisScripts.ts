// Everything the driver feed needs, in one call: each indexed vehicle that is
// still this person's, its room, the vehicle it tows and the truck towing it.
// An index entry whose room closed or whose vehicle changed hands is removed.
// KEYS: the driver's index. ARGV: their Roblox id.
export const DRIVER_VIEW = `
local owner = ARGV[1]
local out = {}
for _, member in ipairs(redis.call('SMEMBERS', KEYS[1])) do
    local sep = string.find(member, ':', 1, true)
    local roomId = sep and string.sub(member, 1, sep - 1) or ''
    local vehicleId = sep and string.sub(member, sep + 1) or ''
    local roomKey = 'room:' .. roomId
    local list = 'dispatchroom:' .. roomId .. ':vehicles'
    local prefix = list .. ':'
    if not sep or redis.call('EXISTS', roomKey) == 0 or redis.call('HGET', prefix .. vehicleId, 'ownerId') ~= owner then
        redis.call('SREM', KEYS[1], member)
    else
        local vehicle = {}
        local fields = redis.call('HGETALL', prefix .. vehicleId)
        for i = 1, #fields, 2 do vehicle[fields[i]] = fields[i + 1] end
        local function other(id)
            if not id or id == '' then return cjson.null end
            local found = redis.call('HMGET', prefix .. id, 'id', 'name', 'ownerId')
            if not found[1] then return cjson.null end
            return {id = found[1], name = found[2] or '', ownerId = found[3] or '0'}
        end
        local towedBy = cjson.null
        for _, id in ipairs(redis.call('LRANGE', list, 0, -1)) do
            if id ~= vehicleId and redis.call('HGET', prefix .. id, 'towing') == vehicleId then
                towedBy = other(id)
                break
            end
        end
        local room = redis.call('HMGET', roomKey, 'groupId', 'eventId', 'eventName', 'occurrence', 'expiresAt', 'revision', 'timeline')
        table.insert(out, {roomId = roomId, vehicle = vehicle, towing = other(vehicle.towing), towedBy = towedBy,
            room = {groupId = room[1] or '', eventId = room[2] or '', eventName = room[3] or '', occurrence = room[4] or '',
                expiresAt = room[5] or '0', revision = room[6] or '0', timeline = room[7] or '[]'}})
    end
end
if #out == 0 then return '[]' end
return cjson.encode(out)
`
