// Real app event paths, without network. Run: node test/funnel.js
const assert = require('node:assert/strict');
const { game } = require('./deck-region');
let passed = 0;
async function test(name, fn){ await fn(); console.log('PASS '+name); passed++; }
function visit(options={}){
  const requests=[];
  const g=game({ ...options, analytics:true, fetch:async (url, init)=>{
    requests.push({url, ...init}); return {ok:true,json:async()=>({})};
  }});
  const steps=()=>requests.filter(r=>r.url.endsWith('/beacon')).map(r=>JSON.parse(r.body).step);
  const count=s=>steps().filter(x=>x===s).length;
  g.run('nextTurn=()=>{}; renderGame=()=>{}; saveGame=()=>{}; loadRest=()=>{};');
  function start(mode='survival', incoming=false){
    g.run(`S.mode=${JSON.stringify(mode)}; S.turbo=false;
      S.challenge=${incoming ? '{idx:[0,1,2,3,4,5],incoming:true,beat:2}' : 'null'};
      S.players=[{name:'Test player',timeline:[],tries:0,hits:0,results:[],timeMs:0}];
      S.deck=[{id:'it1',name:'Song',artist:'Artist',year:1980},{id:'it2',name:'Other',artist:'Artist',year:1990}];
      S.used=new Set(); startGame();`);
  }
  return {g,requests,steps,count,start};
}
(async()=>{
  await test('new cohort survives local history writes and counts exactly one second start',()=>{
    const v=visit(); v.start();
    v.g.run('bumpLife("cards"); overlayGameOver(false);');
    v.start(); v.start();
    for(const step of ['land','start','finish','second-start']){
      assert.equal(v.count(step),1,step); assert.equal(v.count(step+'-new'),1,step+'-new');
    }
    const reloaded=visit({data:v.g.data}); reloaded.start();
    assert.equal(reloaded.count('second-start'),0); assert.equal(reloaded.count('start-new'),0);
  });
  await test('returning visitors and saved-game resumes do not create new-player or second-start events',()=>{
    const saved={mode:'survival',players:[{name:'Player',timeline:[]}],deck:[],used:[]};
    const v=visit({entries:{tl_life:'{"games":1}',tl_game:JSON.stringify(saved)}});
    v.g.run('resumeSaved(); measureGameFinish();');
    assert.deepEqual(v.steps(),['land']);
    v.start(); assert.equal(v.count('second-start'),0);
    v.start(); assert.equal(v.count('second-start'),1);
    assert(!v.steps().some(s=>s.endsWith('-new')));
  });
  await test('failed song loading does not count as a game or challenge played',async()=>{
    const v=visit({hash:'#c=0.1.2.3.4.5&s=3'});
    v.g.run('resolveInitial=async()=>0;'); await v.g.run('startChallenge()');
    assert.equal(v.count('challenge-opened'),1); assert.equal(v.count('start'),0);
    assert.equal(v.count('challenge-played'),0);
  });
  await test('valid incoming links open once; malformed links are ignored',()=>{
    const v=visit({hash:'#c=0.1.2.3.4.5&s=3'});
    v.g.run('boot()'); assert.equal(v.count('challenge-opened'),1);
    for(const hash of ['#c=999999.999998','#c=0..1','#notc=0.1','#c=0.1.2.3.4.5.6']){
      const bad=visit({hash}); assert.equal(bad.count('challenge-opened'),0,hash);
      assert.equal(bad.g.run('S.challenge'),null,hash);
    }
  });
  await test('incoming challenge must finish all songs; fresh challenges do not count as recipients',()=>{
    const v=visit(); v.start('challenge',true);
    v.g.run('S.players[0].tries=2; measureGameFinish();');
    assert.equal(v.count('challenge-played'),0);
    v.start('challenge',false); v.g.run('S.players[0].tries=5; measureGameFinish();');
    assert.equal(v.count('challenge-played'),0);
    v.start('challenge',true); v.g.run('S.players[0].tries=5; overlayRunOver(); measureGameFinish();');
    assert.equal(v.count('challenge-played'),1);
  });
  await test('tutorial completion records finish, then daily is the second game',()=>{
    const v=visit(); v.start('tut');
    v.g.run('S.players[0].tries=3; overlayTutOver();');
    assert.equal(v.count('finish-new'),1);
    v.start('daily'); assert.equal(v.count('second-start-new'),1);
  });
  await test('successful shares and clipboard copies count; cancellation and failed copies do not',async()=>{
    for(const method of ['share','clipboard']){
      let reject=true;
      const action=async()=>{if(reject) throw Error('cancelled');};
      const navigator=method==='share' ? {share:action} : {clipboard:{writeText:action}};
      const v=visit({navigator});
      await v.g.run('shareChallengeIdx([0,1,2,3,4,5],3,12)');
      assert.equal(v.count('challenge-shared'),0);
      reject=false; await v.g.run('shareChallengeIdx([0,1,2,3,4,5],3,12)');
      assert.equal(v.count('challenge-shared'),1);
      await v.g.run('shareResultBack([0,1,2,3,4,5],3,12,2)');
      assert.equal(v.count('challenge-shared'),1);
    }
    const v=visit(); await v.g.run('shareChallengeIdx([0,1],2,12)');
    assert.equal(v.count('challenge-shared'),0,'toast fallback is not a share');
  });
  await test('friend send counts only success; existing inbox scores never count as a new play',async()=>{
    const v=visit(); v.g.run('socialPost=async()=>({ok:false});');
    await v.g.run('sendChal("friend", "0.1.2.3.4.5",3,1000)');
    assert.equal(v.count('challenge-shared'),0);
    v.g.run('socialPost=async()=>({ok:true});');
    await v.g.run('sendChal("friend", "0.1.2.3.4.5",3,1000)');
    assert.equal(v.count('challenge-shared'),1);
    v.g.run('_social={inbox:[{id:1,kind:"challenge",payload:{set:"0.1.2.3.4.5",score:3}}]}; chalPlayed=()=>({s:2,t:9000}); socialGet=async()=>null;');
    await v.g.run('playInboxChal(1)');
    assert.equal(v.count('challenge-opened'),1); assert.equal(v.count('challenge-played'),0);
    assert.equal(v.count('start'),0);
  });
  await test('beacons contain only allowed event names and exclude cookies and referrers',()=>{
    const v=visit({hash:'#c=0.1.2.3.4.5&s=3&f=aaaaaaaaaaaaaaaa'}); v.start(); v.start();
    for(const r of v.requests.filter(r=>r.url.endsWith('/beacon'))){
      assert.deepEqual(Object.keys(JSON.parse(r.body)),['step']);
      assert.equal(r.credentials,'omit'); assert.equal(r.referrerPolicy,'no-referrer');
      assert(!/aaaaaaaa|Test player|#c=/.test(JSON.stringify(r)));
    }
  });
  await test('blocked storage and rejected analytics requests do not break play',async()=>{
    const v=visit({blockStorage:true});
    v.g.run('fetch=()=>Promise.reject(Error("offline"));'); v.start(); v.start();
    v.g.run('measureGameFinish();');
    await new Promise(resolve=>setImmediate(resolve));
  });
  console.log(`${passed} funnel checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
