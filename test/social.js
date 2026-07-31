// E2E: social client — claim a handle, friends card (code/requests/add),
// inbox challenge -> plays the exact set, direct-challenge buttons on results.
// /social is stubbed with a tiny in-memory state machine.
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
  await new Promise(r=>server.listen(8108,r));
  const base='http://localhost:8108/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1400},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  let tid=1;
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1990-01-01',previewUrl:'http://localhost:8108/clip.wav'}]})})`});
  });

  // tiny /social state machine
  const state = { me: null, friends: [], requests: [], outgoing: 0, inbox: [] };
  const actions = [];
  await pg.route(/lb\.test/, route=>{
    const req = route.request();
    const u = req.url();
    if(/\/social/.test(u)){
      if(req.method()==='POST'){
        const b = JSON.parse(req.postData());
        actions.push(b);
        if(b.action==='claim') state.me = { handle:b.handle, code:'YW-ABC234' };
        if(b.action==='add'){   // instant friendship — no accept round-trip
          state.friends = [...state.friends, {id:'f9', handle:'Zoe', w:0, l:0, t:0}];
        }
        if(b.action==='accept'){ state.requests = []; state.friends = [{id:'f1', handle:'Jesse', avatar:'m:12'}]; }
        if(b.action==='seen'){ state.inbox = state.inbox.filter(m=>!b.ids.includes(m.id)); }
        if(b.action==='challenge'){ state.sent = [{to:b.to, handle: b.to==='f9'?'Zoe':'Jesse', at: Date.now()}]; }
        if(b.action==='remove'){ state.friends = state.friends.filter(f=>f.id!==b.user); }
      }
      route.fulfill({contentType:'application/json', body: JSON.stringify(state),
        headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'}});
      return;
    }
    // daily/chal endpoints: minimal happy responses
    const body = /\/chal/.test(u)
      ? { set:'x', total:1, results:[{nick:'You',score:2,timeMs:9000,you:true}] }
      : { day:18, total:1, me:{nick:'You',score:2,timeMs:9000,rank:1}, top:[] };
    route.fulfill({contentType:'application/json', body: JSON.stringify(body),
      headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'}});
  });

  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(800);
  // this context tests the social flows with Google OFF (clientId cleared)
  await pg.evaluate(()=>{ LB.url='https://lb.test'; GAUTH.clientId=''; goTab('friends'); });
  await pg.waitForTimeout(500);

  // 1) no profile -> claim card
  let card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(!/Claim a name/.test(card)) throw new Error('claim card missing: '+card.slice(0,120));
  if(/Played before|Google/.test(card)) throw new Error('Google UI must stay hidden while GAUTH.clientId is empty');
  // the wrapper div hides the card from the .card + .card sibling rule —
  // it needs its own top margin to breathe under the challenge card
  const fcM = await pg.$eval('#friendsCard .card', e=>getComputedStyle(e).marginTop);
  if(fcM !== '16px') throw new Error('friends card missing top margin: '+fcM);
  // typeless inputs must pick up the dark theme (UA default is white)
  const inCss = await pg.$eval('#handleIn', e=>{ const s=getComputedStyle(e); return s.backgroundColor+'|'+s.borderRadius; });
  if(/rgb\(255, 255, 255\)/.test(inCss) || !/1[0-9]px/.test(inCss)) throw new Error('handle input not dark-themed: '+inCss);
  await pg.$eval('#handleIn', e=>{ e.value='Sam K'; });
  await pg.click('#friendsCard button:has-text("Claim")');
  await pg.waitForTimeout(400);
  card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(!/YW-ABC234/.test(card)) throw new Error('friend code not shown after claim: '+card.slice(0,160));
  const claimAct = actions.find(a=>a.action==='claim');
  if(!claimAct || claimAct.handle!=='Sam K') throw new Error('claim POST wrong: '+JSON.stringify(claimAct));
  // claim adopts the handle as the shared board nickname (identity now on Profile tab)
  const adopted = await pg.evaluate(()=>lbNick());
  if(adopted!=='Sam K') throw new Error('claim did not adopt the handle as nick: '+adopted);
  console.log('claim: card + code + nick sync OK');

  // 1b) the code button SHARES an invite link (app share, not just clipboard)
  await pg.evaluate(()=>{ navigator.share = t=>{ window.__shared=(t&&t.text)||String(t); return Promise.resolve(); }; });
  await pg.click('#friendsCard button[aria-label="Share your friend code"]');
  await pg.waitForTimeout(200);
  const codeShared = await pg.evaluate(()=>window.__shared);
  if(!codeShared || !/YW-ABC234/.test(codeShared) || !/#add=YW-ABC234/.test(codeShared))
    throw new Error('code share text wrong: '+codeShared);
  // with zero friends the card leads with a BIG invite button (same share)
  if(!/Invite a friend/.test(await pg.$eval('#friendsCard', e=>e.innerText))) throw new Error('empty-state invite button missing');
  await pg.evaluate(()=>{ window.__shared=null; });
  await pg.click('#friendsCard button:has-text("Invite a friend")');
  await pg.waitForTimeout(200);
  const invShared = await pg.evaluate(()=>window.__shared);
  if(!invShared || !/#add=YW-ABC234/.test(invShared)) throw new Error('invite button share wrong: '+invShared);
  console.log('friend code: share sheet with invite link (chip + big empty-state button) OK');

  // 2) incoming friend request -> accept
  state.requests = [{id:'f1', handle:'Jesse'}];
  await pg.evaluate(()=>socialGet().then(st=>renderFriendsCard(st)));
  await pg.waitForTimeout(300);
  card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(!/Jesse wants to be friends/.test(card)) throw new Error('request row missing: '+card.slice(0,160));
  await pg.click('#friendsCard button:has-text("Accept")');
  await pg.waitForTimeout(400);
  card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(!/Jesse/.test(card) || /wants to be friends/.test(card)) throw new Error('accept did not settle: '+card.slice(0,160));
  if(!actions.some(a=>a.action==='accept' && a.user==='f1')) throw new Error('accept POST missing');
  // friend's server-synced avatar (m:12) renders as an SVG, not just an initial
  const jesseSvg = await pg.evaluate(()=>{ const a=[...document.querySelectorAll('#friendsCard .avatar')].find(x=>x.closest('.row')&&/Jesse/.test(x.closest('.row').innerText)); return a?/<svg/i.test(a.innerHTML):null; });
  if(!jesseSvg) throw new Error("friend's synced avatar did not render");
  // and my own avatar rides along in the social POST so friends can see me
  if(!actions.some(a=>/^m:\d+$/.test(a.avatar||''))) throw new Error('own avatar not sent to server');
  console.log('friend request accept + friend avatar render + own-avatar sync OK');

  // 3) add by code posts the code and lands as an INSTANT friend
  await pg.$eval('#codeIn', e=>{ e.value='yw-zz88kk'; });
  await pg.click('#friendsCard button:has-text("+ Add")');
  await pg.waitForTimeout(300);
  if(!actions.some(a=>a.action==='add' && a.code==='yw-zz88kk')) throw new Error('add POST missing');
  card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(!/Zoe/.test(card)) throw new Error('instant friend not rendered: '+card.slice(0,200));
  console.log('add-by-code: instant friend OK');

  // 4a) multiple challenges from one sender bundle into a single row (oldest
  // is "next"), other senders keep their own row; ✕ dismisses the whole pile
  state.inbox = [
    {id:21, from:'f1', handle:'Jesse', kind:'challenge', payload:{set:'1.2.3.4.5.6', score:2, timeMs:9000}, created:11},
    {id:22, from:'f1', handle:'Jesse', kind:'challenge', payload:{set:'2.3.4.5.6.7', score:4, timeMs:9000}, created:12},
    {id:23, from:'f1', handle:'Jesse', kind:'challenge', payload:{set:'3.4.5.6.7.8', score:3, timeMs:9000}, created:13},
    {id:24, from:'f9', handle:'Zoe', kind:'challenge', payload:{set:'9.8.7.6.5.4', score:5, timeMs:9000}, created:14},
  ];
  await pg.evaluate(()=>socialGet().then(st=>renderFriendsCard(st)));
  await pg.waitForTimeout(300);
  card = await pg.$eval('#friendsCard', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Jesse sent 3 challenges — next: beat 2\/5/.test(card)) throw new Error('bundle row wrong: '+card.slice(0,280));
  if(!/Zoe challenged you — beat 5\/5/.test(card)) throw new Error('single row lost in bundling: '+card.slice(0,280));
  if((card.match(/challenged you|sent \d+ challenges/g)||[]).length!==2) throw new Error('rows not bundled: '+card.slice(0,320));
  await pg.click('#friendsCard button[aria-label="Dismiss all from Jesse"]');
  await pg.waitForTimeout(300);
  const pile = actions.find(a=>a.action==='seen' && a.ids && a.ids.length===3);
  if(!pile || JSON.stringify([...pile.ids].sort((a,b)=>a-b))!==JSON.stringify([21,22,23])) throw new Error('dismiss-all wrong: '+JSON.stringify(pile));
  card = await pg.$eval('#friendsCard', e=>e.innerText.replace(/\s+/g,' '));
  if(/Jesse sent/.test(card) || !/Zoe challenged you/.test(card)) throw new Error('dismiss-all cleared the wrong rows: '+card.slice(0,280));
  console.log('challenge bundling: one row per sender, oldest first + dismiss-all OK');

  // 4) inbox challenge -> Play launches THAT set with the beat score
  state.inbox = [{id:7, from:'f1', handle:'Jesse', kind:'challenge', payload:{set:'10.20.30.40.50.60', score:4, timeMs:12000}, created:1}];
  await pg.evaluate(()=>socialGet().then(st=>renderFriendsCard(st)));
  await pg.waitForTimeout(300);
  card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(!/Jesse challenged you — beat 4\/5/.test(card)) throw new Error('inbox row missing: '+card.slice(0,200));
  await pg.click('#friendsCard button:has-text("▶ Play")');
  await pg.waitForSelector('.slot.active',{timeout:30000});
  const st = await pg.evaluate(()=>({mode:S.mode, beat:S.challenge && S.challenge.beat, idx:S.challenge && S.challenge.idx.join('.')}));
  if(st.mode!=='challenge' || st.beat!==4 || st.idx!=='10.20.30.40.50.60') throw new Error('inbox play state wrong: '+JSON.stringify(st));
  // NOT marked seen yet — the message is consumed on the results screen, so an
  // aborted start (resolution failure) keeps the challenge for a retry
  if(actions.some(a=>a.action==='seen' && a.ids && a.ids.includes(7))) throw new Error('challenge seen too early (before the run finished)');
  console.log('inbox challenge plays the exact set (beat 4/5), not consumed early OK');

  // 5) finish the run; results offer direct-send buttons per friend
  for(let i=1;i<=5;i++){
    await pg.waitForSelector('.slot.active',{timeout:30000});
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:8000});
    if(i===5) break;
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:8000}).catch(()=>{});
    await pg.waitForTimeout(200);
  }
  await pg.waitForTimeout(500);
  const sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  // decluttered duel sheet: scoreline is THE score (no separate big n/5), one
  // [Rematch][Pass on] action row instead of a strip of friend chips, sticky Done
  if(/straight to a friend/.test(sheet)) throw new Error('old direct-send row still present: '+sheet.slice(0,240));
  if(!/Rematch/.test(sheet) || !/Pass on/.test(sheet)) throw new Error('Rematch/Pass-on row missing: '+sheet.slice(0,240));
  if(!/Result sent back to Jesse/.test(sheet)) throw new Error('friend-challenge "result sent" confirmation missing: '+sheet.slice(0,240));
  if(/Send your result back/.test(sheet)) throw new Error('redundant link-share shown for a friend challenge: '+sheet.slice(0,240));
  if(!(await pg.$('#sheet .sheetfoot'))) throw new Error('sticky Done footer missing on duel sheet');
  console.log('duel sheet: decluttered (no chip row), Rematch + Pass on + sticky Done OK');
  // 5a) this run came from Jesse's inbox challenge -> reaction row present;
  // 6 primary reactions + a "…" expander for the rest
  if(!/react to Jesse/.test(sheet)) throw new Error('reaction row missing: '+sheet.slice(0,240));
  if((await pg.$eval('#reactMore', e=>getComputedStyle(e).display)) !== 'none') throw new Error('extra reactions should start hidden');
  await pg.click('#reactRow button:has-text("…")');
  await pg.waitForTimeout(150);
  if((await pg.$eval('#reactMore', e=>getComputedStyle(e).display)) === 'none') throw new Error('… did not expand the extra reactions');
  await pg.click('#reactRow button:has-text("🔥")');
  await pg.waitForTimeout(300);
  const rAct = actions.find(a=>a.action==='react');
  if(!rAct || rAct.to!=='f1' || rAct.emoji!=='🔥') throw new Error('react POST wrong: '+JSON.stringify(rAct));
  const disabled = await pg.$$eval('#reactRow button, #reactMore button', bs=>bs.every(b=>b.disabled));
  if(!disabled) throw new Error('reaction buttons should lock after one send');
  console.log('reaction row: 6 + expander, sends 🔥 to Jesse once OK');
  // pass the set on via the sheet: Jesse (the challenger) is excluded, Zoe is offered
  await pg.click('#sheet button:has-text("Pass on")');
  await pg.waitForTimeout(300);
  const passSheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(/Jesse/.test(passSheet)) throw new Error('pass-on sheet offers the challenger: '+passSheet.slice(0,240));
  if(!/Zoe/.test(passSheet) || !/Share a link/.test(passSheet)) throw new Error('pass-on sheet incomplete: '+passSheet.slice(0,240));
  await pg.click('#sheet button:has-text("Zoe")');
  await pg.waitForTimeout(300);
  const sent = actions.find(a=>a.action==='challenge');
  if(!sent || sent.to!=='f9' || !/^\d+(\.\d+)+$/.test(sent.set) || sent.score==null) throw new Error('pass-on challenge POST wrong: '+JSON.stringify(sent));
  console.log('pass-on sheet: challenger excluded, set sent to Zoe OK ·', JSON.stringify({to:sent.to, score:sent.score}));

  // 5b-bis0) the outstanding challenge shows as ⏳ on Zoe's friend row + in the feed
  await pg.evaluate(()=>{ document.getElementById('overlay').classList.remove('show'); goTab('friends'); });
  await pg.waitForTimeout(500);
  const fcNow = await pg.$eval('#friendsCard', e=>e.innerHTML);
  if(!/⏳/.test(fcNow)) throw new Error('outstanding-challenge hourglass missing on friend row');
  const feedNow = await pg.$eval('#feedCard', e=>e.innerText.replace(/\s+/g,' '));
  if(!/You challenged Zoe[\s\S]*⏳/.test(feedNow) && !/⏳/.test(feedNow)) throw new Error('feed missing waiting marker: '+feedNow.slice(0,200));
  console.log('outstanding challenge: ⏳ on friend row + feed OK');

  // 5b-bis) the activity feed logged all of it: incoming challenge, duel verdict,
  // outgoing challenge — and renders on the Friends tab
  const feed = await pg.evaluate(()=>loadFeed());
  if(!feed.some(e=>e.k==='chal-in' && e.who==='Jesse')) throw new Error('feed missing incoming challenge: '+JSON.stringify(feed));
  if(!feed.some(e=>e.k==='duel' && e.who==='Jesse')) throw new Error('feed missing duel verdict: '+JSON.stringify(feed));
  if(!feed.some(e=>e.k==='chal-out' && e.who==='Zoe')) throw new Error('feed missing outgoing challenge: '+JSON.stringify(feed));
  await pg.evaluate(()=>{ document.getElementById('overlay').classList.remove('show'); goTab('friends'); });
  await pg.waitForTimeout(400);
  const feedTxt = await pg.$eval('#feedCard', e=>e.innerText.replace(/\s+/g,' '));
  if(!/recent activity/i.test(feedTxt) || !/Jesse challenged you/.test(feedTxt) || !/You challenged Zoe/.test(feedTxt))
    throw new Error('feed card wrong: '+feedTxt.slice(0,300));
  // inbox events must not duplicate on the next poll (dedupe by message id)
  const n1 = (await pg.evaluate(()=>loadFeed())).filter(e=>e.k==='chal-in').length;
  await pg.evaluate(()=>socialGet());
  await pg.waitForTimeout(300);
  const n2 = (await pg.evaluate(()=>loadFeed())).filter(e=>e.k==='chal-in').length;
  if(n2 !== n1) throw new Error('feed duplicated inbox events on re-poll: '+n1+' -> '+n2);
  console.log('activity feed: in/out challenges + duel verdict rendered, no dupes OK');

  // 5b-ter) with friends present, the Challenges card opens a WHO-picker first
  await pg.evaluate(()=>{ document.getElementById('overlay').classList.remove('show'); goTab('play'); });
  await pg.waitForTimeout(300);
  await pg.click('.modecard:has-text("Challenges")');
  await pg.waitForTimeout(300);
  const picker = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Who are you challenging\?/.test(picker) || !/Jesse/.test(picker) || !/Anyone — share a link/.test(picker))
    throw new Error('challenge picker missing: '+picker.slice(0,240));
  await pg.click('#sheet button:has-text("Cancel")');
  await pg.waitForTimeout(200);
  if(await pg.$('#overlay.show')) throw new Error('picker did not close on Cancel');
  if(!(await pg.$('.modecard'))) throw new Error('cancel should stay in the lobby');
  console.log('challenge picker: friends listed + link fallback + cancel OK');

  // 5b-quater) both friend-picker sheets with a FULL list (8 friends) on a
  // narrow phone. This is where the sticky footer used to swallow the primary
  // action: "Share a link" sat in the flow BELOW a sheetfoot that pinned itself
  // to the bottom, so it rendered underneath the bar and off the sheet.
  const pickerAudit = async (open, tag) => {
    await pg.evaluate(()=>{ document.getElementById('overlay').classList.remove('show'); });
    await pg.evaluate(()=>{
      _social = _social || {};
      _social.friends = Array.from({length:8}, (_,i)=>({ id:'p'+i, handle:['Turbo Penguin','Groovy Flamingo','Sjaeky',
        'Vinyl Flamingo','Retro Llama','Shady Penguin','Retro Walrus','Turbo Otter'][i], avatar:'m:'+(i+2), w:0,l:0,t:0 }));
    });
    await pg.evaluate(open);
    await pg.waitForTimeout(350);
    const r = await pg.evaluate(()=>{
      const sheet = document.getElementById('sheet');
      const list = sheet.querySelector('.ovlist');
      const foot = sheet.querySelector('.sheetfoot');
      const rows = [...sheet.querySelectorAll('.ovrow')];
      const sr = sheet.getBoundingClientRect();
      const clip = list ? list.getBoundingClientRect() : sr;
      const limit = foot ? foot.getBoundingClientRect().top : sr.bottom;
      // every action must be fully on-sheet and clear of the button bar
      const buried = [...sheet.querySelectorAll('.btn')].filter(b=>{
        if(foot && foot.contains(b)) return false;
        const q = b.getBoundingClientRect();
        return q.bottom > limit + 1 || q.bottom > sr.bottom + 1;
      }).map(b=>b.textContent.trim());
      const footBtns = foot ? [...foot.querySelectorAll('.btn')].map(b=>b.textContent.trim()) : [];
      const footClipped = foot ? foot.getBoundingClientRect().bottom > sr.bottom + 1 : false;
      // rows showing through below the buttons — measure the CLIPPED part, a
      // row inside .ovlist is cut off by it and its raw rect lies about this
      const peeking = rows.filter(q=>{ const b = q.getBoundingClientRect();
        const vis = Math.min(b.bottom, clip.bottom);
        return vis > Math.min(limit, sr.bottom) + 1 && vis > Math.max(b.top, clip.top); }).length;
      // a flex item's box is ONE rect even when its text wraps, so compare
      // against the line height rather than counting rects
      const wrapped = rows.filter(q=>{ const b = q.querySelector('b'); if(!b) return false;
        const lh = parseFloat(getComputedStyle(b).lineHeight) || 20;
        return b.getBoundingClientRect().height > lh * 1.4; }).map(q=>q.querySelector('b').textContent);
      return { rows: rows.length, hasList: !!list, buried, footBtns, footClipped, peeking, wrapped,
               acts: rows.map(q=>{ const a = q.querySelector('.ovact'); return a && a.textContent.trim(); }) };
    });
    if(r.rows !== 8) throw new Error(tag+': expected 8 rows, got '+r.rows);
    if(!r.hasList) throw new Error(tag+': friend list is not its own scroll area');
    if(r.buried.length) throw new Error(tag+': action(s) hidden under/below the button bar: '+JSON.stringify(r.buried));
    if(r.footClipped) throw new Error(tag+': the button bar itself runs off the sheet');
    if(!r.footBtns.length) throw new Error(tag+': no actions in the button bar');
    if(r.peeking) throw new Error(tag+': '+r.peeking+' friend row(s) peek out below the buttons');
    if(r.wrapped.length) throw new Error(tag+': name(s) wrap onto a second line: '+JSON.stringify(r.wrapped));
    if(r.acts.some(a=>!a)) throw new Error(tag+': a row has no labelled action pill');
    return r;
  };
  const pk = await pickerAudit(()=>openChallengePicker(), 'picker');
  await pg.evaluate(()=>{ S.passSet = { idx:[1,2,3,4,5], score:3, timeMs:41000 }; });
  const po = await pickerAudit(()=>openPassOnSheet(), 'pass-on');
  if(!po.footBtns.some(t=>/Share a link/.test(t))) throw new Error('pass-on: Share a link is not in the button bar: '+JSON.stringify(po.footBtns));
  if(!pk.footBtns.some(t=>/share a link/i.test(t))) throw new Error('picker: link fallback is not in the button bar: '+JSON.stringify(pk.footBtns));
  console.log('picker sheets @8 friends: labelled pills, actions reachable, no wrapped names OK ·',
    pk.acts[0]+'/'+po.acts[0]);

  await pg.evaluate(()=>{ document.getElementById('overlay').classList.remove('show'); });
  await pg.evaluate(()=>goTab('friends'));   // later sections expect the Friends tab
  await pg.waitForTimeout(300);

  // 5c) finishing an inbox challenge reports the duel result (msg id 7) —
  // and a LOST duel gets no confetti
  const resAct = actions.find(a=>a.action==='result');
  if(!resAct || resAct.id!==7 || !Number.isFinite(resAct.score)) throw new Error('result POST wrong: '+JSON.stringify(resAct));
  if(!actions.some(a=>a.action==='seen' && a.ids && a.ids.includes(7))) throw new Error('challenge not consumed (seen) at run end');
  if(await pg.$('#confetti')) throw new Error('confetti on a lost duel');
  console.log('duel result + seen reported at run end (id 7), no confetti on a loss OK');

  // 5d) a WON challenge bursts confetti; reduced motion suppresses it
  await pg.evaluate(()=>{
    document.getElementById('overlay').classList.remove('show');
    S.mode='challenge'; S.current=null; S.lastReveal=null; S.reactTo=null;
    S.players=[{name:'You', hits:5, timeMs:1000, results:[1,1,1,1,1], timeline:[]}];
    S.challenge={idx:[11,12,13,14,15,16], beat:2, beatTime:null};
    overlayRunOver();
  });
  await pg.waitForTimeout(300);
  const bits = await pg.$$eval('#confetti i', els=>els.length).catch(()=>0);
  if(!bits) throw new Error('no confetti on a won challenge');
  await pg.emulateMedia({reducedMotion:'reduce'});
  await pg.evaluate(()=>{
    const c=document.getElementById('confetti'); if(c) c.remove();
    document.getElementById('overlay').classList.remove('show');
    S.challenge={idx:[21,22,23,24,25,26], beat:1, beatTime:null};
    overlayRunOver();
  });
  await pg.waitForTimeout(200);
  if(await pg.$('#confetti')) throw new Error('confetti despite prefers-reduced-motion');
  await pg.emulateMedia({reducedMotion:'no-preference'});
  console.log('confetti on a won duel, suppressed under reduced motion OK');

  // 5b) an incoming reaction renders in the friends card and dismisses
  state.inbox = [{id:9, from:'f1', handle:'Jesse', kind:'react', payload:{emoji:'😂', score:2}, created:2}];
  await pg.click('#sheet button:has-text("Done")');
  await pg.waitForTimeout(600);
  card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(!/Jesse reacted 😂 to your challenge/.test(card)) throw new Error('reaction inbox row missing: '+card.slice(0,220));
  await pg.click('#friendsCard button:has-text("Got it")');
  await pg.waitForTimeout(300);
  if(!actions.some(a=>a.action==='seen' && a.ids && a.ids.includes(9))) throw new Error('dismiss seen POST missing');
  card = await pg.$eval('#friendsCard', e=>e.innerText);
  if(/Jesse reacted/.test(card)) throw new Error('dismissed reaction still shown');
  console.log('incoming reaction row + dismiss OK');

  // 5b2) react-BACK: a result row offers 💬 which opens the reaction sheet
  state.inbox = [{id:14, from:'f1', handle:'Jesse', kind:'result', payload:{score:4, w:'them'}, created:5}];
  await pg.evaluate(()=>socialGet().then(b=>renderFriendsCard(b)));
  await pg.waitForTimeout(400);
  const rb = await pg.$('#friendsCard button:has-text("React"), #friendsCard button:has-text("Reply")');
  if(!rb) throw new Error('react-back button missing on result row');
  const nRB = actions.length;
  await rb.click();
  await pg.waitForTimeout(200);
  await pg.click('#sheet button:has-text("🔥")');
  await pg.waitForTimeout(300);
  const react = actions.slice(nRB).find(a=>a.action==='react');
  if(!react || react.to!=='f1' || react.emoji!=='🔥') throw new Error('react-back POST wrong: '+JSON.stringify(react));
  console.log('react-back from result row: 💬 → sheet → POST OK');

  // 5b3) share links carry the sender; the parser reads it back
  const linkBits = await pg.evaluate(()=>{
    localStorage.setItem('tl_user', JSON.stringify({id:'ab12'.repeat(8), handle:'Sam', code:'YW-XXXXXX'}));
    const tag = senderTag();
    location.hash = '#c=1.2.3.4.5.6&s=3&t=44' + tag;
    const parsed = parseChallengeHash();
    history.replaceState(null,'',location.pathname);
    return { tag, from: parsed && parsed.fromUser, beat: parsed && parsed.beat };
  });
  if(linkBits.tag !== '&f='+'ab12'.repeat(8)) throw new Error('senderTag wrong: '+linkBits.tag);
  if(linkBits.from !== 'ab12'.repeat(8) || linkBits.beat !== 3) throw new Error('parse of f= wrong: '+JSON.stringify(linkBits));
  console.log('share links carry sender id + parser reads it OK');

  // 5e) friends card renders the duel leaderboard + a challenger result row
  await pg.evaluate(()=>renderFriendsCard({
    me:{handle:'Sam', code:'YW-XXXXXX'},
    friends:[{id:'f2', handle:'Kim', w:0, l:0, t:0}, {id:'f1', handle:'Jesse', w:3, l:1, t:1}],
    requests:[], outgoing:0,
    inbox:[{id:11, from:'f1', handle:'Jesse', kind:'result', payload:{score:5, timeMs:60000, w:'them'}, created:3},
           {id:12, from:'f2', handle:'Kim', kind:'friend', payload:{}, created:4}]
  }));
  await pg.waitForTimeout(200);
  card = await pg.$eval('#friendsCard', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Kim used your code — you're friends now/.test(card)) throw new Error('friend note row missing: '+card.slice(0,300));
  if(!/👑 you 3–1 · 1 tie/.test(card)) throw new Error('duel record missing: '+card.slice(0,240));
  if(!(/Jesse[\s\S]*👑[\s\S]*Kim/.test(await pg.$eval('#friendsCard', e=>e.innerText)))) throw new Error('duel sort wrong (Jesse should rank above Kim)');
  if(!/Jesse played your challenge — 5\/5 · they beat you/.test(card)) throw new Error('challenger result row missing: '+card.slice(0,300));
  if(!await pg.$('#friendsCard button[aria-label="Challenge Jesse"]')) throw new Error('per-friend challenge button missing');
  console.log('friends card: duel leaderboard sorted + result row + ⚔️ buttons OK');

  // 5f) tapping a friend's ⚔️ starts a fresh run and auto-sends the gauntlet
  const nActs = actions.length;
  await pg.click('#friendsCard button[aria-label="Challenge Jesse"]');
  for(let i=1;i<=5;i++){
    await pg.waitForSelector('.slot.active',{timeout:30000});
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:8000});
    if(i===5) break;
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:8000}).catch(()=>{});
    await pg.waitForTimeout(200);
  }
  await pg.waitForTimeout(500);
  const autoChal = actions.slice(nActs).find(a=>a.action==='challenge');
  if(!autoChal || autoChal.to!=='f1' || !/^\d+(\.\d+)+$/.test(autoChal.set) || autoChal.score==null)
    throw new Error('friend challenge did not auto-send: '+JSON.stringify(autoChal));
  const sheet2 = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Challenge sent to Jesse!/.test(sheet2) || !/You set \d\/5 to beat/.test(sheet2)) throw new Error('sent hero missing: '+sheet2.slice(0,260));
  if(await pg.$$eval('#sheet .ovrow', els=>els.some(e=>/Jesse/.test(e.innerText)))) throw new Error('target friend should not reappear on the results sheet');
  // the pass-on button covers "challenge someone else"; Jesse is excluded inside it
  if(!/Challenge friends/.test(sheet2)) throw new Error('pass-on button missing after auto-send: '+sheet2.slice(0,260));
  await pg.click('#sheet button:has-text("Challenge friends")');
  await pg.waitForTimeout(300);
  const pass2 = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(/Jesse/.test(pass2)) throw new Error('pass-on sheet offers the already-challenged friend: '+pass2.slice(0,200));
  console.log('friend ⚔️ button: fresh run + auto-sent gauntlet + pass-on excludes target OK');

  // 5g) tapping a friend's NAME opens the head-to-head sheet (all-time,
  // rolling 7 days, recent duels), with a challenge button inside
  await pg.click('#sheet button:has-text("Done")');
  await pg.waitForTimeout(500);
  await pg.evaluate(()=>{
    _social = { me:{handle:'Sam', code:'YW-XXXXXX'},
      friends:[{id:'f1', handle:'Jesse', w:3, l:1, t:1, w7:2, l7:0, t7:0,
        recent:[{r:'w', mine:5, theirs:4, at:Date.now()-864e5},
                {r:'l', mine:2, theirs:4, at:Date.now()-3*864e5}]}],
      requests:[], outgoing:0, inbox:[] };
    renderFriendsCard(_social);
  });
  await pg.waitForTimeout(200);
  await pg.click('#friendsCard .frname:has-text("Jesse")');
  await pg.waitForTimeout(200);
  const dtl = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Jesse/.test(dtl) || !/all-time: you 3–1 · 1 tie/.test(dtl)) throw new Error('all-time record wrong: '+dtl.slice(0,240));
  if(!/last 7 days: 👑 you lead — 2–0/.test(dtl)) throw new Error('7-day line wrong: '+dtl.slice(0,240));
  if(!/yesterday · you 5\/5 vs 4\/5 🏆/.test(dtl)) throw new Error('recent duel line wrong: '+dtl.slice(0,300));
  if(!/3 days ago · you 2\/5 vs 4\/5/.test(dtl)) throw new Error('older duel line wrong: '+dtl.slice(0,300));
  if(!/Challenge Jesse/.test(dtl)) throw new Error('challenge button missing in detail sheet');
  await pg.click('#sheet button:has-text("Close")');
  await pg.waitForTimeout(200);
  if(await pg.$eval('#overlay', e=>e.classList.contains('show'))) throw new Error('detail sheet did not close');
  console.log('friend detail sheet: all-time + 7-day crown + recent duels OK');

  // 5h) tapping the friends HEADER opens the all-standings sheet; a row
  // drills into that friend's detail
  await pg.click('#friendsCard .eyebtn');
  await pg.waitForTimeout(200);
  let ovr = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/STANDINGS/.test(ovr)) throw new Error('standings sheet missing: '+ovr.slice(0,200));
  if(!/all-time/.test(ovr) || !/last 7 days/.test(ovr)) throw new Error('standings column headers missing: '+ovr.slice(0,240));
  if(!/Jesse[\s\S]*👑 3–1 \+1[\s\S]*2–0/.test(ovr)) throw new Error('standings row wrong: '+ovr.slice(0,300));
  await pg.click('#sheet .ovrow:has-text("Jesse")');
  await pg.waitForTimeout(200);
  ovr = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/all-time: you 3–1 · 1 tie/.test(ovr)) throw new Error('standings row did not open the detail: '+ovr.slice(0,240));
  await pg.click('#sheet button:has-text("Close")');
  await pg.waitForTimeout(200);
  console.log('standings sheet: header tap + drill-down to detail OK');

  // 5i) removing a friend: two-tap confirm in the detail sheet → action:remove
  await pg.click('#friendsCard .frname:has-text("Jesse")');
  await pg.waitForTimeout(200);
  const rmBtn = await pg.$('#sheet button[aria-label="Remove Jesse as a friend"]');
  if(!rmBtn) throw new Error('remove-friend button missing from detail sheet');
  const nRem = actions.length;
  await rmBtn.click();
  await pg.waitForTimeout(200);
  if(actions.slice(nRem).some(a=>a.action==='remove')) throw new Error('remove fired on FIRST tap — confirm step skipped');
  if(!/Sure\? Tap again/.test(await pg.$eval('#sheet', e=>e.innerText))) throw new Error('remove button did not arm');
  await pg.click('#sheet button[aria-label="Remove Jesse as a friend"]');
  await pg.waitForTimeout(400);
  const rem = actions.slice(nRem).find(a=>a.action==='remove');
  if(!rem || rem.user!=='f1') throw new Error('remove action wrong: '+JSON.stringify(rem));
  if(await pg.$eval('#overlay', e=>e.classList.contains('show'))) throw new Error('detail sheet still open after removal');
  if(await pg.$('#friendsCard button[aria-label="Challenge Jesse"]')) throw new Error('removed friend still in the roster');
  console.log('remove friend: armed confirm + POST + roster refresh OK');

  // Inbox actions must READ as buttons. They were bare glyphs, and the same ✓
  // meant "accept this person" in one row and "make this go away" two rows up.
  await pg.evaluate(()=>{
    const st = { me:{id:'me',handle:'Sam',code:'YW-ME0001'},
      friends:[{id:'f9',handle:'Kim',w:0,l:0,t:0,recent:[]}],
      requests:[{id:'r1',handle:'Nora'}], outgoing:0, outgoingIds:[],
      inbox:[ {id:1,kind:'challenge',from:'f9',handle:'Kim',payload:{score:4},created:1},
              {id:2,kind:'friend',from:'f8',handle:'Bram',payload:{}},
              {id:3,kind:'result',from:'f9',handle:'Kim',payload:{w:'you',score:3}},
              {id:4,kind:'react',from:'f9',handle:'Kim',payload:{emoji:'👏'}} ] };
    _social = st; renderFriendsCard(st);
  });
  await pg.waitForTimeout(300);
  const acts = await pg.$$eval('#friendsCard .inboxrow button, #friendsCard .row .btn.pink',
    els => els.map(e => e.textContent.trim()));
  for(const label of ['▶ Play','✓ Got it','💬 React','💬 Reply','✓ Accept','Decline'])
    if(!acts.includes(label)) throw new Error('missing labelled action "'+label+'": '+JSON.stringify(acts));
  // no action may be a bare glyph — that is the thing being fixed
  const bare = acts.filter(t => t.replace(/[^\p{L}\p{N}]/gu,'').length === 0);
  if(bare.length) throw new Error('unlabelled glyph button(s) left: '+JSON.stringify(bare));
  // accept must stand out from dismiss, not look identical
  const accept = await pg.$eval('#friendsCard .inboxrow button.pink', e=>e.textContent.trim());
  if(accept !== '✓ Accept') throw new Error('accept is not the highlighted action: '+accept);
  console.log('inbox actions: every one a labelled button, accept highlighted OK · '+acts.length+' actions');

  await ctx.close();

  // 6) Google sign-in — fake GIS button + stubbed /auth restores the account
  const ctx2 = await browser.newContext({viewport:{width:540,height:1400},hasTouch:true,serviceWorkers:'block'});
  const pg2 = await ctx2.newPage();
  pg2.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  const authPosts = [];
  const state2 = { me:null, friends:[], requests:[], outgoing:0, inbox:[] };
  await pg2.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');
    route.fulfill({contentType:'text/javascript',body:`${cb}({"resultCount":0,"results":[]})`});
  });
  await pg2.route(/lb\.test/, route=>{
    const req=route.request();
    if(/\/auth/.test(req.url()) && req.method()==='POST'){
      authPosts.push(JSON.parse(req.postData()));
      state2.me = { handle:'Tim', code:'YW-TTT222', linked:true };
    }
    route.fulfill({contentType:'application/json', body: JSON.stringify(state2),
      headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'}});
  });
  await pg2.addInitScript(()=>{
    window.google = { accounts: { id: {
      initialize(o){ window.__gcb = o.callback; },
      renderButton(el){ const b=document.createElement('button'); b.id='fakeGsi';
        b.textContent='Sign in with Google'; b.onclick=()=>window.__gcb({credential:'FAKE.JWT.TOK'});
        el.appendChild(b); }
    }}};
  });
  await pg2.goto(base,{waitUntil:'load'});
  await pg2.waitForTimeout(700);
  await pg2.evaluate(()=>{ LB.url='https://lb.test'; GAUTH.clientId='test-client'; goTab('friends'); });
  await pg2.waitForTimeout(400);
  let c2 = await pg2.$eval('#friendsCard', e=>e.innerText);
  if(!/Played before on another phone/.test(c2)) throw new Error('sign-in hint missing on claim card: '+c2.slice(0,160));
  // our themed pill carries the look; Google's real button overlays it invisibly
  if(!await pg2.$('#gsiBtn .gbtn')) throw new Error('themed google pill missing');
  const gOp = await pg2.$eval('#gsiBtn .greal', e=>getComputedStyle(e).opacity);
  if(parseFloat(gOp) > 0.05) throw new Error('real google button should be invisible, opacity='+gOp);
  const hasBtn = await pg2.$('#gsiBtn #fakeGsi');
  if(!hasBtn) throw new Error('Google button not mounted');
  await pg2.click('#fakeGsi');
  await pg2.waitForTimeout(400);
  if(authPosts.length!==1 || authPosts[0].credential!=='FAKE.JWT.TOK' || !/^[a-f0-9]{32}$/.test(authPosts[0].device))
    throw new Error('auth POST wrong: '+JSON.stringify(authPosts));
  c2 = await pg2.$eval('#friendsCard', e=>e.innerText);
  if(!/YW-TTT222/.test(c2) || !/Google-linked/.test(c2)) throw new Error('restored account not shown: '+c2.slice(0,200));
  if((await pg2.evaluate(()=>lbNick()))!=='Tim') throw new Error('nick did not adopt restored handle');
  console.log('Google sign-in: hidden-until-configured, button mounts, /auth restores account + linked badge OK');
  await ctx2.close();

  // 7) opening an invite link (#add=CODE) arms the code; claiming a name
  // then fires the friend request automatically
  const ctx3 = await browser.newContext({viewport:{width:540,height:1400},hasTouch:true,serviceWorkers:'block'});
  const pg3 = await ctx3.newPage();
  pg3.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  const actions3 = [];
  const state3 = { me:null, friends:[], requests:[], outgoing:0, inbox:[] };
  await pg3.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');
    route.fulfill({contentType:'text/javascript',body:`${cb}({"resultCount":0,"results":[]})`});
  });
  await pg3.route(/lb\.test/, route=>{
    const req=route.request();
    if(/\/social/.test(req.url()) && req.method()==='POST'){
      const b=JSON.parse(req.postData()); actions3.push(b);
      if(b.action==='claim') state3.me = { handle:b.handle, code:'YW-NEW111' };
      if(b.action==='add') state3.friends = [{id:'x1', handle:'Inviter', w:0, l:0, t:0}];   // instant friendship
    }
    route.fulfill({contentType:'application/json', body: JSON.stringify(state3),
      headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'}});
  });
  await pg3.goto(base+'#add=YW-ZZ77KK',{waitUntil:'load'});
  await pg3.waitForTimeout(700);
  const armed = await pg3.evaluate(()=>({ pend: store.get('tl_pendingAdd'), hash: location.hash }));
  if(armed.pend!=='YW-ZZ77KK') throw new Error('invite code not armed: '+JSON.stringify(armed));
  if(/add=/.test(armed.hash)) throw new Error('invite hash not cleaned: '+armed.hash);
  // production boot has LB configured; simulate that then re-render → a claim-name
  // popup should appear on the CURRENT tab (not force a navigation yet)
  await pg3.evaluate(()=>{ LB.url='https://lb.test'; GAUTH.clientId=''; renderSetup(); });
  await pg3.waitForTimeout(500);
  if(!(await pg3.$('#inviteName'))) throw new Error('invite claim popup did not appear');
  if((await pg3.evaluate(()=>_tab))!=='play') throw new Error('popup should not leave the current tab yet');
  if(actions3.some(a=>a.action==='add')) throw new Error('add fired before a profile exists');
  await pg3.$eval('#inviteName', e=>{ e.value='Frodo'; });
  await pg3.click('#sheet button:has-text("Claim name")');
  await pg3.waitForTimeout(600);
  const addAct = actions3.find(a=>a.action==='add');
  if(!addAct || addAct.code!=='YW-ZZ77KK') throw new Error('pending add did not fire after claim: '+JSON.stringify(actions3));
  if(await pg3.evaluate(()=>store.get('tl_pendingAdd'))) throw new Error('pending code not cleared after add');
  if((await pg3.evaluate(()=>_tab))!=='friends') throw new Error('did not land on Friends tab after claiming via invite');
  if(await pg3.$('#overlay.show')) throw new Error('claim popup did not close after claiming');
  console.log('invite link: claim-name popup → auto-add + land on Friends OK');
  await ctx3.close();

  console.log('SOCIAL TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
