// E2E: the year-correction report button — visible now REPORT.url is set,
// posts the 5 form fields (title/artist/old/new/build) to the Google Form.
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
  await new Promise(r=>server.listen(8071,r));
  const base='http://localhost:8071/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  let tid=1;
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8071/clip.wav',trackViewUrl:'https://music.apple.com/nl/song/'+tid}]})})`});
  });
  let reported = null;
  await pg.route(/docs\.google\.com/, route=>{
    reported = { url: route.request().url(), body: route.request().postData()||'' };
    route.fulfill({status:200, body:''});
  });
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);

  // solo classic game -> place one card -> reveal overlay
  await pg.click('.modecard:has-text("Pass & Play")');
  await pg.click('#players .row >> nth=1 >> .iconbtn');
  await pg.click('text=▶ Start game');
  await pg.waitForSelector('.slot.active',{timeout:20000});
  await pg.click('.slot.active');
  await pg.waitForSelector('#overlay.show',{timeout:5000});

  // reveal carries the Apple Music attribution link (Phase-0 commercial item)
  const reveal = await pg.$eval('#sheet', e=>e.innerHTML);
  if(!/Open in Apple Music/.test(reveal) || !/music\.apple\.com/.test(reveal)) throw new Error('Apple Music link missing on reveal');
  console.log('reveal: Apple Music attribution link present ✓');

  // open the flag details, correct the year, then report
  await pg.click('.report-yr summary');
  const oldYear = await pg.$eval('#sheet .rev-yr', e=>Number(e.value));
  await pg.$eval('#sheet .rev-yr', e=>{ e.value = String(Number(e.value)+1); e.dispatchEvent(new Event('change')); });
  await pg.click('text=Report this fix');
  await pg.waitForTimeout(500);

  if(!reported) throw new Error('no POST reached docs.google.com');
  if(!/formResponse/.test(reported.url)) throw new Error('wrong endpoint: '+reported.url);
  const need = ['entry.1538100355','entry.252531345','entry.539229286','entry.1144383384','entry.329807473'];
  for(const k of need) if(!reported.body.includes(k)) throw new Error('missing field '+k+' in body: '+reported.body.slice(0,300));
  if(!reported.body.includes(String(oldYear))) throw new Error('old year not in body');
  if(!reported.body.includes(String(oldYear+1))) throw new Error('corrected year not in body');
  const build = await pg.evaluate(()=>BUILD);
  if(!reported.body.includes(build)) throw new Error('build tag '+build+' not in body');
  const toast = await pg.$eval('body', e=>e.innerText);
  if(!/Reported — thanks/.test(toast)) throw new Error('thank-you toast missing');
  console.log('report flow: button visible, POST to formResponse with all 5 entry ids + old/new year + build ✓');

  // EVERY mode's reveal must offer the year-report control — survival shipped
  // without it (hearts replaced the flag block) and it's the most-replayed mode
  await pg.evaluate(()=>{ closeOverlay(); backToSetup(); goTab('play'); });
  await pg.waitForTimeout(400);
  await pg.click('.modecard:has-text("Survival")');
  await pg.click('text=🎯 Start survival');
  await pg.waitForSelector('.slot.active',{timeout:20000});
  await pg.click('.slot.active');
  await pg.waitForSelector('#overlay.show',{timeout:5000});
  const sReveal = await pg.$eval('#sheet', e=>e.innerHTML);
  if(!/report-yr/.test(sReveal)) throw new Error('survival reveal is missing the year-report block');
  if(!/❤️|🖤/u.test(sReveal)) throw new Error('survival reveal lost its hearts');
  await pg.click('.report-yr summary');
  if(!await pg.$('#sheet .rev-yr')) throw new Error('survival year input not reachable');
  console.log('survival reveal: hearts + year-report block present ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
