// Each room operation merges inside Redis. Concurrent hosts never overwrite
// another host's extension or a dispatcher's acknowledgment.
const PREAMBLE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local now = tonumber(ARGV[1])
local room = {}
local fields = redis.call('HGETALL', KEYS[1])
for i=1,#fields,2 do room[fields[i]] = fields[i+1] end
local timeline = cjson.decode(room.timeline or '[]')
local start = tonumber(room.startAt)
local finish = tonumber(room.expiresAt)
`
const SNAPSHOT = `
local snapshot = {roomId=ARGV[2], groupId=room.groupId, eventId=room.eventId, eventName=room.eventName, occurrence=room.occurrence,
botConnected=room.botConnected == 'true', endsAt=finish, activeUntil=tonumber(room.activeUntil), timeline=timeline,
note=room.note or '', ownerRobloxId=room.ownerRobloxId or '', imageUrl=room.imageUrl or ''}
if snapshot.ownerRobloxId == '' then snapshot.ownerRobloxId = cjson.null end
if snapshot.imageUrl == '' then snapshot.imageUrl = cjson.null end
local encoded = cjson.encode(snapshot)
if #timeline == 0 then encoded = string.gsub(encoded, '"timeline":{}', '"timeline":[]') end
`
const STORE = `
redis.call('HSET', KEYS[1], 'timeline', cjson.encode(timeline))
${SNAPSHOT}
redis.call('PUBLISH', ARGV[3], '{"event":"HOST","data":' .. encoded .. '}')
return encoded
`
export const READ_HOST = `${PREAMBLE}${SNAPSHOT}return encoded`
export const EXTEND_HOST = `${PREAMBLE}
finish = finish + tonumber(ARGV[4]) * 60000
room.activeUntil = tostring(finish + 1800000)
redis.call('HSET', KEYS[1], 'needsRefresh', now)
redis.call('HSET', KEYS[1], 'expiresAt', finish, 'activeUntil', room.activeUntil)
local ttl = math.max(1, math.ceil((finish + 1800000 - now)/1000))
if redis.call('HLEN', 'dispatchroom:' .. ARGV[2] .. ':users') > 0 then ttl = math.max(7200, ttl + 7200) end
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
local vehicles = 'dispatchroom:' .. ARGV[2] .. ':vehicles'
local vehicleTtl = math.max(28800, ttl)
for _, id in ipairs(redis.call('LRANGE', vehicles, 0, -1)) do redis.call('EXPIRE', vehicles .. ':' .. id, vehicleTtl) end
redis.call('EXPIRE', vehicles, vehicleTtl)
for _, item in ipairs(timeline) do
    if item.status == 'WAITING' or item.status == 'READY' then
        if item.reference == 'END' then item.dueAt = finish + item.offsetMinutes * 60000 end
    end
end
table.sort(timeline, function(a,b) return a.dueAt < b.dueAt end)
${STORE}`
export const CHANGE_EVENT = `${PREAMBLE}
local target
for _, item in ipairs(timeline) do if item.id == ARGV[4] then target = item end end
if not target then return 'NOT_FOUND' end
local operation = ARGV[5]
if target.status ~= 'WAITING' and target.status ~= 'READY' and not target.awaitingAck then return 'CONFLICT' end
if target.awaitingAck and operation ~= 'ACKNOWLEDGE' and operation ~= 'SKIP' then return 'CONFLICT' end
if ARGV[6] == 'DISPATCH' and (operation ~= 'ACKNOWLEDGE' or target.audience == 'HOST' or (target.status ~= 'READY' and not target.awaitingAck)) then return 'FORBIDDEN' end
if operation == 'RESCHEDULE' then
    target.reference = ARGV[7]
    target.offsetMinutes = tonumber(ARGV[8])
    target.dueAt = (target.reference == 'START' and start or finish) + target.offsetMinutes * 60000
    target.status = 'WAITING'
    table.sort(timeline, function(a,b) return a.dueAt < b.dueAt end)
elseif operation == 'SKIP' then target.status = 'SKIPPED'
elseif operation == 'ACKNOWLEDGE' then target.status = 'ACKNOWLEDGED'
elseif target.action == 'BEGIN' or target.action == 'STAFF_START' or target.action == 'COMPLETE' then
    target.status = 'QUEUED'
    target.source = 'STAFF'
else
    target.status = 'ACTIVATED'
    if target.action == 'RETURN_DEPOT' or target.action == 'REMINDER' then target.awaitingAck = true end
end
if operation == 'ACKNOWLEDGE' or operation == 'SKIP' then target.awaitingAck = nil end
target.changedAt = now
target.actorId = ARGV[9]
${STORE}`
export const SET_NOTE = `${PREAMBLE}
local note = cjson.decode(ARGV[4])
room.note = note.note
room.ownerRobloxId = note.ownerRobloxId == cjson.null and '' or note.ownerRobloxId
if note.imageUrl ~= nil then room.imageUrl = note.imageUrl == cjson.null and '' or note.imageUrl end
redis.call('HSET', KEYS[1], 'note', room.note, 'ownerRobloxId', room.ownerRobloxId, 'imageUrl', room.imageUrl or '')
redis.call('SET', KEYS[2], cjson.encode({note=room.note, ownerRobloxId=room.ownerRobloxId == '' and cjson.null or room.ownerRobloxId, imageUrl=room.imageUrl or ''}), 'EX', 2592000)
redis.call('HSET', KEYS[1], 'needsRefresh', now)
${STORE}`

// One read/settle/claim command per room, irrespective of the number of cards.
export const CLAIM_TIMELINE = `${PREAMBLE}
local due = {}
local changed = false
for index, item in ipairs(timeline) do
    local nextTime = finish + 1800000
    for _, other in ipairs(timeline) do if other.dueAt > item.dueAt then nextTime = math.min(nextTime, other.dueAt) end end
    if item.status == 'RUNNING' and now >= (item.leaseUntil or 0) then item.status = 'QUEUED'; changed = true end
    if item.status == 'WAITING' and now >= item.dueAt then
        if item.automation then item.status = 'QUEUED'; item.source = 'AUTOMATION'
        else item.status = 'READY' end
        changed = true
    end
    if ((item.status == 'READY' or item.status == 'QUEUED') and item.source ~= 'STAFF' or item.awaitingAck) and now >= nextTime then
        item.status = 'IGNORED'; item.awaitingAck = nil; item.changedAt = now; changed = true
    end
    if item.status == 'QUEUED' and ARGV[4] ~= 'READ' then
        item.status = 'RUNNING'; item.leaseUntil = now + 120000; changed = true
        table.insert(due, {action=item.action, timelineId=item.id, roomId=ARGV[2], occurrence=room.occurrence, eventId=room.eventId,
            expiresAt=now + 600000})
    end
end
if changed then
    redis.call('HSET', KEYS[1], 'timeline', cjson.encode(timeline))
    ${SNAPSHOT}
    redis.call('PUBLISH', ARGV[3], '{"event":"HOST","data":' .. encoded .. '}')
end
if room.needsRefresh and tonumber(room.refreshLease or '0') <= now and ARGV[4] ~= 'READ' then
    redis.call('HSET', KEYS[1], 'refreshLease', now + 120000)
    table.insert(due, {action='REFRESH', timelineId='refresh-' .. room.needsRefresh, roomId=ARGV[2], occurrence=room.occurrence, eventId=room.eventId, expiresAt=now+600000})
end
if ARGV[4] == 'READ' then
    ${SNAPSHOT}
    return encoded
end
return #due == 0 and '[]' or cjson.encode(due)
`
export const FINISH_TIMELINE = `${PREAMBLE}
if ARGV[4] == 'refresh-' .. (room.needsRefresh or '') then
    if ARGV[5] == 'RELEASE' then redis.call('HDEL', KEYS[1], 'refreshLease')
    else redis.call('HDEL', KEYS[1], 'needsRefresh', 'refreshLease') end
end
for _, item in ipairs(timeline) do
    if item.id == ARGV[4] and item.status == 'RUNNING' then
        if ARGV[5] == 'RELEASE' then item.status = 'QUEUED'
        else item.status = item.source == 'STAFF' and 'ACTIVATED' or 'AUTOMATED' end
        item.changedAt = now
    end
end
${STORE}`

export const STAFF_ACTION = `${PREAMBLE}
if room.eventId ~= ARGV[4] or room.occurrence ~= ARGV[5] then return false end
for _, item in ipairs(timeline) do
    if item.action == ARGV[6] and (item.status == 'WAITING' or item.status == 'READY' or item.status == 'QUEUED' or item.status == 'RUNNING') then
        item.status = 'ACTIVATED'; item.source = 'STAFF'; item.changedAt = now
    end
end
${STORE}`
