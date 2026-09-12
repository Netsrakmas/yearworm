// Fair race-to-N, smart final round: after someone hits N, only players ONE
// card short still get a turn (they can tie); hopeless players are skipped;
// card-ties are broken by total thinking time.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
function makeWav(){
  const sr=8000,n=3200;const d=Buffer.alloc(n*2);
  for(let i=0;i<n;i++)d.writeInt16LE((Math.floor(i/40)%2)?4000:-4000,i*2);
  const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+d.length,4);h.write('WAVEfmt ',8);
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(sr,24);
  h.writeUInt32LE(sr*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(d.length,40);
  return Buffer.concat([h,d]);
}
const WAV = makeWav();
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  if(p==='/clip.wav'){res.writeHead(200,{'Content-Type':'audio/wav','Access-Control-Allow-Origin':'*'});return res.end(WAV);}
  const f = path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});

(async()=>{
  await new Promise(r=>server.listen(8067,r));
  const base='http://localhost:8067/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1400},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));

  // P1: 9 cards (1900-1908) + a 1999 mystery -> LAST slot is deterministically
  // CORRECT (1999 > 1908) -> P1 hits 10. P2: 9 cards (eligible to tie).
  // P3: 5 cards (hopeless -> must be skipped). Deck mysteries are all >1908,
  // so the last slot stays a correct play for P2 as well.
  const tl = (pre,n) => Array.from({length:n},(_,i)=>({id:pre+i, name:'Seed '+i, artist:'Seeder', year:1900+i}));
  const deck = [
    {id:'d1', name:'Mystery One', artist:'M', year:1999, previewUrl: base+'clip.wav'},
    {id:'d2', name:'Mystery Two', artist:'M', year:2001, previewUrl: base+'clip.wav'},
    {id:'d3', name:'Mystery Three', artist:'M', year:2003, previewUrl: base+'clip.wav'},
  ];
  const save = {v:2, target:10, turn:0, deck, used:['d1'],
    current: deck[0],
    players:[{name:'P1', timeline:tl('x',9)},{name:'P2', timeline:tl('y',9)},{name:'P3', timeline:tl('z',5)}],
    mode:'classic', lives:3, score:0, streak:0, bestStreak:0};
  await pg.addInitScript(s=>localStorage.setItem('tl_game', JSON.stringify(s)), save);
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);
  await pg.click('button:has-text("Resume")');
  await pg.waitForSelector('.slot.active',{timeout:20000});

  // P1 places correct in the LAST slot -> hits 10. Game must continue for P2.
  await pg.click('.slot.active >> nth=-1');
  await pg.waitForSelector('#overlay.show',{timeout:5000});
  let btn = await pg.$eval('#sheet .btn.primary', e=>e.textContent.trim());
  let sub = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/hits 10/.test(sub)) throw new Error('no hits-10 notice: '+sub.slice(0,140));
  if(!/Pass to P2/.test(btn)) throw new Error('expected P2 (one short) to get a final turn, btn='+btn);
  console.log('P1 hits 10: game continues to P2 (eligible to tie) OK');

  // P2's equalizing turn — slower on purpose, also correct in the last slot -> ties at 10
  await pg.click('#sheet .btn.primary');
  await pg.waitForSelector('.slot.active',{timeout:20000});
  await pg.waitForTimeout(1800);
  await pg.click('.slot.active >> nth=-1');
  await pg.waitForSelector('#overlay.show',{timeout:5000});
  btn = await pg.$eval('#sheet .btn.primary', e=>e.textContent.trim());
  if(!/See results/.test(btn)) throw new Error('P3 (hopeless) should be skipped -> results now; btn='+btn);
  console.log('P2 ties at 10; P3 (5 cards) skipped -> results offered OK');

  await pg.click('#sheet .btn.primary');
  await pg.waitForTimeout(400);
  const sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/P1 wins/.test(sheet)) throw new Error('expected P1 (faster) to win the 10-10 tie: '+sheet.slice(0,180));
  if(!/fastest time decides/i.test(sheet)) throw new Error('tie-break note missing: '+sheet.slice(0,180));
  console.log('tie 10-10 → fastest (P1) wins, tie-break note shown OK');
  console.log('FAIR-ROUND TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
