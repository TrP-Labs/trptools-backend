import postgres from 'postgres'
import Redis from 'ioredis'
import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { DEFAULT_SCHEDULE, makeTimeline } from '../src/host/rules'

const database = process.env.HOST_TEST_DATABASE_URL ?? 'postgresql://trptools@127.0.0.1:55432/trptools_hostfix'
if (new URL(database).pathname !== '/trptools_hostfix') throw new Error('Only the isolated trptools_hostfix database is allowed')
const sql = postgres(database, { prepare: false })
const redis = new Redis('redis://127.0.0.1:56379')
const token = randomBytes(24).toString('hex')
const [user] = await sql`insert into users(roblox_id,cached_username,cached_display_name,cached_at) values(${900000000 + Math.floor(Math.random()*100000000)},'Host Tester','Host Tester',now()) returning id`
await sql`insert into sessions(session_id,user_id,expires_at) values(${createHash('sha256').update(token).digest('hex')},${user!.id},now()+interval '1 day')`
const [group] = await sql`select id,slug from groups limit 1`
if (!group) throw new Error('Seed the isolated database first')
await redis.set(`perm:${group.id}:${user!.id}`, '2:100:5:', 'EX', 86400)
await sql`insert into bot_configs(group_id,guild_id,cached_guild_name,owner_roblox_id,announcement_channel,auto_begin,auto_staff_start,auto_complete) values(${group.id},'111111111111111111','Test guild','123','222222222222222222',false,false,false) on conflict(group_id) do update set auto_begin=false,auto_staff_start=false,auto_complete=false,announcement_channel='222222222222222222'`
const start = new Date(Date.now() + 4 * 60000)
const [event] = await sql`insert into events(group_id,slug,name,start_time,rrule,duration,visibility,host_level) values(${group.id},${'test-'+randomBytes(4).toString('hex')},'Hosting regression session',${start},'FREQ=DAILY',60,'PUBLIC',2) returning event_id`
const [sheet] = await sql`insert into signup_sheets(group_id,name,enabled,discord_channel) values(${group.id},'Hosting test staff',true,'333333333333333333') returning id`
const [slot] = await sql`insert into signup_slots(sheet_id,name) values(${sheet!.id},'Dispatcher') returning id`
await sql`insert into shift_signups(slot_id,event_id,discord_user_id,discord_username,occurrence) values(${slot!.id},${event!.event_id},'444444444444444444','Test dispatcher',${start})`
const roomId = randomBytes(10).toString('hex')
const timeline = makeTimeline(DEFAULT_SCHEDULE, start.getTime(), start.getTime()+3600000)
await redis.hset(`room:${roomId}`, {
    groupId:group.id, eventId:event!.event_id, eventName:'Hosting regression session', creatorId:user!.id,
    createdAt:String(Date.now()), startAt:String(start.getTime()), expiresAt:String(start.getTime()+3600000),
    activeUntil:String(start.getTime()+5400000), occurrence:start.toISOString(), botConnected:'true', timeline:JSON.stringify(timeline),
})
await redis.expire(`room:${roomId}`, 86400)
await redis.set(`groupindex:${group.id}`, roomId, 'EX', 86400)
await writeFile('/tmp/trptools-hostfix-fixture.json', JSON.stringify({token,userId:user!.id,groupId:group.id,groupSlug:group.slug,eventId:event!.event_id,roomId,start:start.toISOString()}), {mode:0o600})
console.log('Isolated ordinary-host session ready')
redis.disconnect()
await sql.end()
