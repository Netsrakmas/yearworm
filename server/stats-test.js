// Retention maths, checked against a hand-built history where the right answer
// is known by construction. A silently wrong retention number is worse than no
// number at all — it would drive the whole roadmap.
const fs=require('fs'); const Database=require('better-sqlite3');
(async()=>{
  const sqlite=new Database(':memory:');
  let sc=fs.readFileSync('/home/user/Timeline/server/schema.sql','utf8')
    .replace(/^\s*--.*$/gm,'').replace(/CREATE INDEX[\s\S]*?;/gi,'');
  sqlite.exec(sc);
  const P=a=>a.length?[Object.fromEntries(a.map((v,i)=>[i+1,v===undefined?null:v]))]:[];
  const DB={prepare(sql){const st=sqlite.prepare(sql);let a=[];const api={bind(...x){a=x;return api;},
    first(){const r=st.get(...P(a));return r===undefined?null:r;},all(){return{results:st.all(...P(a))};},
    run(){const i=st.run(...P(a));return{meta:{changes:i.changes}};}};return api;}};
  globalThis.fetch=async()=>({status:201});
  const w=(await import('/home/user/Timeline/server/worker.js')).default;
  const env={DB,STATS_KEY:'s3cret',VAPID_PUBLIC:'',VAPID_PRIVATE:'',GOOGLE_CLIENT_ID:''};
  const ctx={waitUntil:p=>p};

  const today=Math.max(1,Math.floor((Date.now()-Date.UTC(2026,6,1))/864e5)+1);
  const play=(dev,day)=>sqlite.prepare("INSERT INTO scores (day,device,nick,score,time_ms,created) VALUES (?,?,?,?,?,?)")
    .run(day,dev,'x',3,9000,Date.now());

  // A hand-built history. Cohort day = each device's FIRST day.
  play('loyal',   today-10); play('loyal', today-9); play('loyal', today-3);  // d1 ✓, d7 ✓, came back ✓
  play('nextday', today-10); play('nextday', today-9);                        // d1 ✓, d7 ✓, came back ✓
  play('week',    today-10); play('week',   today-4);                         // d1 ✗, d7 ✓, came back ✓
  play('once',    today-10);                                                  // nothing
  play('alsoonce',today-9);                                                   // nothing
  play('late',    today-2);  play('late',   today-1);                         // d1 ✓; too new for d7
  play('newbie',  today);                                                     // too new for BOTH

  const r=await (await w.fetch(new Request('https://x/stats?key=s3cret&json=1',
    {headers:{'Origin':'https://playyearworm.com','CF-Connecting-IP':'2.2.2.2'}}),env,ctx)).json();
  const d=r.daily;
  const eq=(got,want,what)=>{ if(got!==want) throw new Error(what+': expected '+want+', got '+got); };

  eq(d.ever, 7, 'players ever');
  eq(d.back, 4, 'played a 2nd day');              // loyal, nextday, week, late
  eq(d.backPct, 57, 'came-back %');               // 4/7
  // day-1 cohort EXCLUDES 'newbie' (first played today — no chance yet)
  eq(d.d1.cohort, 6, 'd1 cohort');
  eq(d.d1.back, 3, 'd1 returned');                // loyal, nextday, late
  eq(d.d1.pct, 50, 'd1 %');
  // day-7 cohort excludes anyone who first played within the last 7 days
  eq(d.d7.cohort, 5, 'd7 cohort');                // loyal,nextday,week,once,alsoonce
  eq(d.d7.back, 3, 'd7 returned');                // loyal, nextday, week
  eq(d.d7.pct, 60, 'd7 %');
  console.log('cohort maths correct (d1 '+d.d1.pct+'%, d7 '+d.d7.pct+'%, came back '+d.backPct+'%) OK');

  const day = m => d.byDay.find(x=>x.day===m) || {players:0,first:0};
  eq(day(today).players, 1, 'players today');
  eq(day(today).first, 1, 'first-timers today');
  eq(day(today-10).players, 4, 'players on the busiest day');
  eq(day(today-10).first, 4, 'first-timers that day');
  eq(day(today-9).first, 1, 'first-timers next day');   // alsoonce only; nextday/loyal are returning
  console.log('per-day players and first-timers correct OK');

  // the gate must actually gate
  const noKey=await w.fetch(new Request('https://x/stats',{headers:{'Origin':'https://playyearworm.com','CF-Connecting-IP':'2.2.2.3'}}),{...env,STATS_KEY:''},ctx);
  if(noKey.status!==404) throw new Error('stats not disabled without a key: '+noKey.status);
  const wrong=await w.fetch(new Request('https://x/stats?key=guess',{headers:{'Origin':'https://playyearworm.com','CF-Connecting-IP':'2.2.2.4'}}),env,ctx);
  if(wrong.status!==403) throw new Error('wrong key was accepted: '+wrong.status);
  console.log('gate: disabled without STATS_KEY, 403 on a wrong key OK');

  // ---- funnel: landed → started → finished ----
  const beacon = async (step) => { const r = await w.fetch(new Request('https://x/beacon',
    {method:'POST',headers:{'content-type':'application/json','Origin':'https://playyearworm.com','CF-Connecting-IP':'3.3.3.3'},
     body:JSON.stringify({step})}), env, ctx); return r.status; };
  // 10 first-timers land, 6 start a round, 3 finish it
  for(let i=0;i<10;i++){ await beacon('land'); await beacon('land-new'); }
  for(let i=0;i<6;i++){ await beacon('start'); await beacon('start-new'); }
  for(let i=0;i<3;i++){ await beacon('finish'); await beacon('finish-new'); }
  // a junk step must be ignored, not stored
  await beacon('drop-database');
  const f=(await (await w.fetch(new Request('https://x/stats?key=s3cret&json=1',
    {headers:{'Origin':'https://playyearworm.com','CF-Connecting-IP':'2.2.2.6'}}),env,ctx)).json()).funnel;
  eq(f.fresh.land, 10, 'first-timers landed');
  eq(f.fresh.start, 6, 'first-timers started');
  eq(f.fresh.finish, 3, 'first-timers finished');
  eq(f.fresh.startPct, 60, 'start rate');     // 6/10
  eq(f.fresh.finishPct, 50, 'finish rate');   // 3/6 — of those who STARTED
  const junk = sqlite.prepare("SELECT COUNT(*) n FROM funnel WHERE step='drop-database'").get().n;
  eq(junk, 0, 'unknown step stored');
  console.log('funnel: '+f.fresh.land+' landed → '+f.fresh.startPct+'% started → '+f.fresh.finishPct+'% finished, junk rejected OK');

  // the beacon must carry NOTHING identifying: a device token sent anyway is
  // never stored, and the table has no column that could hold one
  await (await w.fetch(new Request('https://x/beacon',{method:'POST',
    headers:{'content-type':'application/json','Origin':'https://playyearworm.com','CF-Connecting-IP':'3.3.3.4'},
    body:JSON.stringify({step:'land', device:'a'.repeat(32), nick:'Sam'})}), env, ctx));
  const cols = sqlite.prepare("PRAGMA table_info(funnel)").all().map(c=>c.name).sort().join(',');
  eq(cols, 'day,n,step', 'funnel columns');
  const dump = JSON.stringify(sqlite.prepare("SELECT * FROM funnel").all());
  if(/aaaa|Sam/.test(dump)) throw new Error('beacon stored identifying data: '+dump);
  console.log('beacon: stores only (day, step, count) — no token or name can be kept OK');

  // and the HTML view renders with no personal data in it
  const html=await (await w.fetch(new Request('https://x/stats?key=s3cret',{headers:{'Origin':'https://playyearworm.com','CF-Connecting-IP':'2.2.2.5'}}),env,ctx)).text();
  if(!/came back/.test(html)||!/day 7/.test(html)) throw new Error('HTML view missing headline numbers');
  for(const leak of ['loyal','nextday','alsoonce','newbie'])
    if(html.includes(leak)) throw new Error('device token leaked into the HTML: '+leak);
  console.log('HTML view renders, no device tokens in it OK');
  console.log('STATS TEST PASS ✓');
})().catch(e=>{console.error('STATS TEST FAIL ✗',e.message);process.exit(1);});
