import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import Redis from 'ioredis'
import { DEFAULT_SCHEDULE, makeTimeline } from '../src/host/rules'

const database = process.env.HOST_TEST_DATABASE_URL ?? 'postgresql://trptools@127.0.0.1:55432/trptools_hostfix'
if(new URL(database).pathname!=='/trptools_hostfix') throw new Error('Only the isolated trptools_hostfix database is allowed')
const fixture = JSON.parse(await readFile('/tmp/trptools-hostfix-fixture.json','utf8'))
const sql = postgres(database,{prepare:false})
const redis = new Redis('redis://127.0.0.1:56379')
const reports:unknown[] = []
const actors: Record<string,string> = {host:fixture.token}
const actorIds:string[]=[]
for(const [name,permissions] of Object.entries({dispatcher:3,viewer:1})) {
    const token = randomBytes(24).toString('hex')
    const [user] = await sql`insert into users(roblox_id,cached_username,cached_display_name,cached_at) values(${900000000+Math.floor(Math.random()*100000000)},${name},${name},now()) returning id`
    actorIds.push(user!.id)
    await sql`insert into sessions(session_id,user_id,expires_at) values(${createHash('sha256').update(token).digest('hex')},${user!.id},now()+interval '1 day')`
    await redis.set(`perm:${fixture.groupId}:${user!.id}`,`2:100:${permissions}:`,'EX',86400)
    actors[name]=token
}
try {
    for(const origin of ['http://localhost:53001','http://localhost:53002','http://localhost:53004']) {
        let requests=0
        async function call(path:string,method='GET',body?:unknown,token=actors.host!,expected=200) {
            const response = await fetch(origin+path,{method,headers:{cookie:`access_token=${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
            const text = await response.text(); requests++
            assert.equal(response.status,expected,`${method} ${path}: ${text}`)
            try{return JSON.parse(text)}catch{return text}
        }
        const room = '/host/'+fixture.roomId
        const timeline = makeTimeline(DEFAULT_SCHEDULE,Date.parse(fixture.start),Date.parse(fixture.start)+3600000)
        for(const item of timeline) item.dueAt = Math.max(Date.now()+60000,item.dueAt)
        await redis.hset('room:'+fixture.roomId,'timeline',JSON.stringify(timeline))
        const controller = new AbortController()
        const stream = await fetch(origin+'/dispatch/'+fixture.roomId+'/connect',{headers:{cookie:`access_token=${actors.host}`},signal:controller.signal})
        assert.equal(stream.status,200)
        const snapshots:any[]=[]
        const reader = stream.body!.getReader()
        const reading = (async()=>{
            let text=''; const decoder=new TextDecoder()
            try{while(true){const frame=await reader.read();if(frame.done)break;text+=decoder.decode(frame.value,{stream:true});let index;while((index=text.indexOf('\n\n'))>=0){const block=text.slice(0,index);text=text.slice(index+2);for(const line of block.split('\n')){if(!line.startsWith('data:'))continue;const event=JSON.parse(line.slice(5));if(event.event==='HOST')snapshots.push(event.data)}}}}
            catch(error){if(!controller.signal.aborted)throw error}
        })()
        async function received(check:(value:any)=>boolean) {
            const deadline=Date.now()+3000
            while(Date.now()<deadline){if(snapshots.some(check))return;await new Promise(resolve=>setTimeout(resolve,20))}
            throw new Error('A host update did not reach the live stream within 3 seconds')
        }
        try {
            await received(value=>value.roomId===fixture.roomId)
            const before=await call(room)
            const duration=(await sql`select duration from events where event_id=${fixture.eventId}`)[0]!.duration
            await Promise.all(Array.from({length:12},()=>call(room+'/extend','POST',{minutes:5})))
            const extended=await call(room)
            assert.equal(extended.endsAt,before.endsAt+3600000)
            assert.equal((await sql`select duration from events where event_id=${fixture.eventId}`)[0]!.duration,duration)
            await received(value=>value.endsAt===extended.endsAt)
            for(const minutes of [-1,0,6,1.5,'5',null,Infinity,{},[],true]) await call(room+'/extend','POST',{minutes},actors.host!,400)
            assert.equal((await call(room)).endsAt,extended.endsAt)
            for(const body of [{note:'x',ownerRobloxId:'abc'},{note:'x'.repeat(1001),ownerRobloxId:null},{note:'x',ownerRobloxId:null,joinCode:'ab'},{note:'x',ownerRobloxId:null,joinCode:'AB CD'},{note:'x',ownerRobloxId:null,announceJoinCode:'false'},{note:'x',ownerRobloxId:null,imageUrl:'http://localhost/private'}]) await call(room+'/note','PUT',body,actors.host!,400)
            const note='Session note '+origin
            const saved=await call(room+'/note','PUT',{note,ownerRobloxId:'123',joinCode:'TEST123',announceJoinCode:false})
            assert.equal(saved.joinCode,'TEST123');assert.equal(saved.announceJoinCode,false)
            await received(value=>value.note===note&&value.joinCode==='TEST123'&&value.announceJoinCode===false)
            const botHeaders={authorization:'Bearer local-host-verification-only','content-type':'application/json'}
            const edit=await fetch(origin+'/bot/internal/guilds/111111111111111111/note',{method:'PUT',headers:botHeaders,body:JSON.stringify({eventId:fixture.eventId,occurrence:fixture.start,note:'Discord edit '+origin,ownerRobloxId:null})})
            assert.equal(edit.status,200);assert.equal(await edit.text(),'Success')
            await received(value=>value.note==='Discord edit '+origin)
            assert.equal((await call(room)).joinCode,'TEST123')
            const rescheduled=await call(room+'/events/edit','POST',{operation:'RESCHEDULE',reference:'END',offsetMinutes:-1440})
            assert.equal(rescheduled.timeline.find((item:any)=>item.id==='edit').dueAt,rescheduled.endsAt-1440*60000)
            for(const body of [{operation:'RESCHEDULE'},{operation:'RESCHEDULE',reference:'START',offsetMinutes:1441},{operation:'RESCHEDULE',reference:'NEVER',offsetMinutes:0},{operation:'INVALID'}])await call(room+'/events/edit','POST',body,actors.host!,400)
            const current=await call(room)
            current.timeline.find((item:any)=>item.id==='edit').status='READY'
            current.timeline.find((item:any)=>item.id==='edit').dueAt=Date.now()+60000
            await redis.hset('room:'+fixture.roomId,'timeline',JSON.stringify(current.timeline))
            await call(room+'/events/edit','POST',{operation:'ACKNOWLEDGE'})
            await received(value=>value.timeline.find((item:any)=>item.id==='edit')?.status==='ACKNOWLEDGED')
            await call(room+'/events/edit','POST',{operation:'ACKNOWLEDGE'},actors.host!,409)
            await call(room+'/events/unknown','POST',{operation:'ACKNOWLEDGE'},actors.host!,404)
            await call(room+'/events/public','POST',{operation:'ACTIVATE'})
            await received(value=>value.timeline.find((item:any)=>item.id==='public')?.status==='QUEUED')
            const invalidCommand=await fetch(origin+'/bot/internal/staff-action',{method:'POST',headers:botHeaders,body:JSON.stringify({guildId:'111111111111111111',eventId:fixture.eventId,occurrence:'not-a-date',action:'BEGIN'})})
            assert.equal(invalidCommand.status,400)
            assert.equal((await call(room)).timeline.find((item:any)=>item.id==='public').status,'QUEUED')
            // Equivalent timestamps from Discord callers must address the same
            // occurrence even when their textual UTC representation differs.
            const command=await fetch(origin+'/bot/internal/staff-action',{method:'POST',headers:botHeaders,body:JSON.stringify({guildId:'111111111111111111',eventId:fixture.eventId,occurrence:fixture.start.replace('Z','+00:00'),action:'BEGIN'})})
            assert.equal(command.status,200)
            await received(value=>value.timeline.find((item:any)=>item.id==='public')?.status==='ACTIVATED')
            await call(room+'/events/public','POST',{operation:'ACKNOWLEDGE'},actors.host!,409)
            await call(room,'GET',undefined,actors.viewer!,403)
            await call(room,'GET',undefined,'invalid',401)
            await call(room+'/extend','POST',{minutes:5},actors.dispatcher!,403)
            await call(room+'/note','PUT',{note:'Denied',ownerRobloxId:null},actors.dispatcher!,403)
            await call(room+'/events/complete','POST',{operation:'ACTIVATE'},actors.dispatcher!,403)
            await call(room+'/events/return-depot','POST',{operation:'ACTIVATE'})
            await call(room+'/events/return-depot','POST',{operation:'ACKNOWLEDGE'},actors.dispatcher!)
            await received(value=>value.timeline.find((item:any)=>item.id==='return-depot')?.status==='ACKNOWLEDGED')
            reports.push({origin,requests,liveSnapshots:snapshots.length,result:'passed'})
            console.log(origin,requests,'HTTP assertions and live updates passed')
        } finally {controller.abort();await reading}
    }
    await writeFile('/tmp/trptools-hostfix-http-results.json',JSON.stringify(reports,null,2))
} finally {
    for(const id of actorIds) await sql`delete from users where id=${id}`
    redis.disconnect();await sql.end()
}
