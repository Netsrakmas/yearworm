// Reproduce Sam's report: play 2 short survival games back-to-back and measure
// how many songs repeat between them. Big default pool, real draw/loader path.
const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright-core');
const ROOT='/home/user/Timeline',CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
function wav(){const sr=8000,n=1600,d=Buffer.alloc(n*2),h=Buffer.alloc(44);
 h.write('RIFF',0);h.writeUInt32LE(36+d.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
 h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(sr*2,28);
 h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(d.length,40);
 return Buffer.concat([h,d]);}
const WAV=wav();
const srv=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
 if(p==='/clip.wav'){res.writeHead(200,{'Content-Type':'audio/wav','Access-Control-Allow-Origin':'*'});return res.end(WAV);}
 const f=path.join(ROOT,p);if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});fs.createReadStream(f).pipe(res);});
let tid=1;
async function playSurvival(pg, nCards){
  const heard=[];
  await pg.evaluate(()=>{ S.mode='survival'; S.turbo=false; });
  await pg.evaluate(()=>onStart());
  await pg.waitForSelector('.slot.active',{timeout:30000});
  for(let i=0;i<nCards;i++){
    await pg.waitForSelector('.slot.active',{timeout:30000});
    const cur=await pg.evaluate(()=> S.current ? (S.current.name+'|'+S.current.artist) : null);
    if(cur) heard.push(cur);
    // place at slot 0 (may be right or wrong; we survive by placing "correct enough"
    // — force correctness by revealing nothing; just click and advance)
    await pg.evaluate(()=>{ S.lives=3; });   // keep alive so we can sample nCards
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:8000});
    const dead = await pg.evaluate(()=> S.lives<=0);
    if(dead) break;
    const btn = await pg.$('#sheet .btn.primary');
    if(btn) await btn.click();
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'),null,{timeout:8000}).catch(()=>{});
    await pg.waitForTimeout(120);
  }
  // exit to menu
  await pg.evaluate(()=>{ closeOverlay(); if(typeof backToMenu==='function') backToMenu(); else backToSetup(); });
  await pg.waitForTimeout(300);
  return heard;
}
(async()=>{
 await new Promise(r=>srv.listen(8101,r));
 const b=await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
 const ctx=await b.newContext({viewport:{width:540,height:1100},hasTouch:true,serviceWorkers:'block'});
 const pg=await ctx.newPage();
 pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
 await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
 await pg.route(/itunes\.apple\.com/,route=>{
  const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
  route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8101/clip.wav'}]})})`});});
 await pg.goto('http://localhost:8101/',{waitUntil:'load'});
 await pg.waitForTimeout(700);
 const pool=await pg.evaluate(()=>({sel:S.selectedIds, n:selectedSongs().length}));
 console.log('pool:', JSON.stringify(pool));

 // SCENARIO B: the real user flow — die, tap "Play again" (playAgain), repeat
 console.log('== scenario: PLAY AGAIN button ==');
 const games=[];
 await pg.evaluate(()=>{ localStorage.removeItem('tl_played'); S.mode='survival'; S.turbo=false; });
 await pg.evaluate(()=>onStart());
 await pg.waitForSelector('.slot.active',{timeout:30000});
 for(let g=0; g<4; g++){
   const heard=[];
   for(let i=0;i<8;i++){
     await pg.waitForSelector('.slot.active',{timeout:30000});
     const cur=await pg.evaluate(()=> S.current ? (S.current.name+'|'+S.current.artist):null);
     if(cur) heard.push(cur);
     await pg.evaluate(()=>{ S.lives=3; });
     await pg.click('.slot.active');
     await pg.waitForSelector('#overlay.show',{timeout:8000});
     const btn=await pg.$('#sheet .btn.primary');
     if(btn && i<7) { await btn.click(); await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'),null,{timeout:8000}).catch(()=>{}); await pg.waitForTimeout(120); }
   }
   games.push(heard);
   console.log(`game ${g+1}: heard ${heard.length}`);
   // tap "Play again" via the function (game-over sheet is up)
   await pg.evaluate(()=>{ if(typeof playAgain==='function') playAgain(); });
   await pg.waitForSelector('.slot.active',{timeout:30000});
 }
 // "Play again" after a short survival run must not redeal the same songs
 const earlier=new Set([].concat(...games.slice(0,3)));
 const dup4=games[3].filter(x=>earlier.has(x));
 // from a 2029-song pool, four 8-card games should barely overlap (birthday
 // baseline ~0-1); the reused-deck bug produced 4-6/8. Guard well below that.
 if(dup4.length > 2) throw new Error(`Play-again redeals recent songs: ${dup4.length}/8 repeats (bug regressed) → ${dup4.slice(0,4).join(', ')}`);
 console.log(`Play-again freshness: game 4 shares ${dup4.length}/8 with games 1-3 (expected ~0) OK`);
 await b.close(); srv.close();
 console.log('REPEATS TEST PASS ✓');
})().catch(e=>{console.error('REPEATS TEST FAIL ✗', e.message);process.exit(1);});
