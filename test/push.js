const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright-core');
const ROOT='/home/user/Timeline',CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const srv=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
 const f=path.join(ROOT,p);if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});fs.createReadStream(f).pipe(res);});
(async()=>{
 await new Promise(r=>srv.listen(8099,r));
 const b=await chromium.launch({executablePath:CHROME});
 const ctx=await b.newContext({viewport:{width:440,height:1200},hasTouch:true,serviceWorkers:'block',deviceScaleFactor:2});
 const pg=await ctx.newPage(); pg.on('pageerror',e=>console.log('PAGEERR:',e.message));
 // stub push APIs (headless Chromium can't do real web push)
 await pg.addInitScript(()=>{
   const fakeSub={ endpoint:'https://push.example/abc', toJSON(){ return { endpoint:this.endpoint, keys:{ p256dh:'BFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeK', auth:'AuthSecretXXXXXXXXXXXX' } }; }, async unsubscribe(){ return true; } };
   let cur=null;
   const reg={ pushManager:{ async getSubscription(){ return cur; }, async subscribe(){ cur=fakeSub; return fakeSub; } } };
   const swFake={ register:async()=>reg, ready:Promise.resolve(reg), addEventListener(){}, };
   try{ Object.defineProperty(navigator,'serviceWorker',{ configurable:true, get:()=>swFake }); }catch(e){}
   window.PushManager=function(){};
   const N=function(){}; N.permission='default'; N.requestPermission=async()=>{ N.permission='granted'; return 'granted'; };
   try{ Object.defineProperty(window,'Notification',{ configurable:true, get:()=>N }); }catch(e){}
   try{ localStorage.setItem('tl_nick','Sam'); localStorage.setItem('tl_user', JSON.stringify({code:'YW-ME0001'})); }catch(e){}
 });
 let pushSub=null, pushTz;
 await pg.route(/lb\.test/, route=>{ const req=route.request();
   if(/\/social/.test(req.url())){ let bd={}; try{bd=JSON.parse(req.postData());}catch(e){}
     if(bd.action==='push-sub'){ pushSub=bd.sub; pushTz=bd.tz; return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({ok:true})}); }
     return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({me:{handle:'Sam',code:'YW-ME0001'},friends:[],requests:[],outgoing:0,inbox:[]})}); }
   return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({day:16,total:1,me:null,top:[]})});
 });
 await pg.goto('http://localhost:8099/',{waitUntil:'load'}); await pg.waitForTimeout(400);
 await pg.evaluate(()=>{ LB.url='https://lb.test'; });
 await pg.evaluate(()=>goTab('profile')); await pg.waitForTimeout(400);
 // 1) card renders with "Turn on"
 const card = await pg.$eval('#app', e=>e.innerText);
 if(!/Notifications/.test(card) || !/Turn on/.test(card)) throw new Error('notifications card missing: '+card.slice(0,300));
 console.log('profile notifications card: present + Turn on OK');
 // 2) enable flow: click Turn on → subscribe → push-sub POST → tl_push set → flips to Turn off
 await pg.click('button:has-text("Turn on")'); await pg.waitForTimeout(500);
 if(!pushSub || !/push.example/.test(pushSub.endpoint)) throw new Error('push-sub not posted: '+JSON.stringify(pushSub));
 if(!Number.isFinite(pushTz)) throw new Error('tz missing from push-sub (streak nudge needs it): '+pushTz);
 if((await pg.evaluate(()=>store.get('tl_push')))!=='1') throw new Error('tl_push not set');
 if((await pg.evaluate(()=>pushEnabled()))!==true) throw new Error('pushEnabled() false after enable');
 await pg.waitForTimeout(200);
 if(!/Turn off/.test(await pg.$eval('#app',e=>e.innerText))) throw new Error('toggle did not flip to Turn off');
 console.log('enable push: subscribe + push-sub POST + toggle flip OK ·', pushSub.endpoint);
 // 3) deep link: a FRESH load of #tab=friends starts on the Friends tab
 const pg2=await ctx.newPage();
 await pg2.route(/lb\.test/, r=>r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({me:null,friends:[],requests:[],outgoing:0,inbox:[]})}));
 await pg2.goto('http://localhost:8099/#tab=friends',{waitUntil:'load'}); await pg2.waitForTimeout(500);
 if((await pg2.evaluate(()=>_tab))!=='friends') throw new Error('deep-link tab not honored: '+(await pg2.evaluate(()=>_tab)));
 if(/tab=/.test(await pg2.evaluate(()=>location.hash))) throw new Error('deep-link hash not cleaned');
 console.log('notification deep-link #tab=friends → Friends tab OK');

 // 4) "Send test": an iPhone has no devtools, so a failed push must come back as
 // a status the player can read and act on — 403 means a pre-rotation sub.
 let testReply={ ok:false, vapid:{configured:true,match:true}, subs:1, sent:[{status:403,host:'push.example'}] };
 await pg.route(/lb\.test/, route=>{ const req=route.request(); let bd={}; try{bd=JSON.parse(req.postData());}catch(e){}
   const send=o=>route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(o)});
   if(bd.action==='push-test') return send(testReply);
   if(bd.action==='push-sub') return send({ok:true});
   return send({me:{handle:'Sam',code:'YW-ME0001'},friends:[],requests:[],outgoing:0,inbox:[]});
 });
 await pg.evaluate(()=>goTab('profile')); await pg.waitForTimeout(300);
 await pg.click('#pushTestBtn'); await pg.waitForTimeout(500);
 let out = await pg.$eval('#pushTestOut', e=>e.innerText);
 if(!/403/.test(out) || !/off, then on/i.test(out)) throw new Error('403 not explained actionably: '+out);
 testReply={ ok:true, vapid:{configured:true,match:true}, subs:1, sent:[{status:201,host:'push.example'}] };
 await pg.click('#pushTestBtn'); await pg.waitForTimeout(500);
 out = await pg.$eval('#pushTestOut', e=>e.innerText);
 if(!/Sent to 1 device/.test(out)) throw new Error('successful test not confirmed: '+out);
 console.log('send test: 403 explained + success confirmed OK');

 // 5) a subscription created with the PREVIOUS VAPID key is silently rejected
 // forever (403). Boot must notice the key moved and re-subscribe by itself.
 let unsubEp=null, resubEp=null;
 const pg3=await ctx.newPage(); pg3.on('pageerror',e=>console.log('PAGEERR3:',e.message));
 await pg3.addInitScript(()=>{
   const keys={ p256dh:'BFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeK', auth:'AuthSecretXXXXXXXXXXXX' };
   const mk=ep=>({ endpoint:ep, toJSON(){ return { endpoint:ep, keys }; }, async unsubscribe(){ return true; } });
   let cur=mk('https://push.example/old');
   const reg={ pushManager:{ async getSubscription(){ return cur; }, async subscribe(){ cur=mk('https://push.example/fresh'); return cur; } } };
   const swFake={ register:async()=>reg, ready:Promise.resolve(reg), addEventListener(){}, };
   try{ Object.defineProperty(navigator,'serviceWorker',{ configurable:true, get:()=>swFake }); }catch(e){}
   window.PushManager=function(){};
   const N=function(){}; N.permission='granted'; N.requestPermission=async()=>'granted';
   try{ Object.defineProperty(window,'Notification',{ configurable:true, get:()=>N }); }catch(e){}
   try{ localStorage.setItem('tl_nick','Sam'); localStorage.setItem('tl_user', JSON.stringify({code:'YW-ME0001'}));
     localStorage.setItem('tl_push','1'); localStorage.setItem('tl_pushkey','BKeyFromBeforeTheRotation'); }catch(e){}
 });
 await pg3.route(/lb\.test/, route=>{ let bd={}; try{bd=JSON.parse(route.request().postData());}catch(e){}
   const send=o=>route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(o)});
   if(bd.action==='push-unsub'){ unsubEp=bd.endpoint; return send({ok:true}); }
   if(bd.action==='push-sub'){ resubEp=bd.sub&&bd.sub.endpoint; return send({ok:true}); }
   return send({me:{handle:'Sam',code:'YW-ME0001'},friends:[],requests:[],outgoing:0,inbox:[]});
 });
 await pg3.goto('http://localhost:8099/',{waitUntil:'load'});
 await pg3.evaluate(()=>{ LB.url='https://lb.test'; });
 await pg3.waitForFunction(()=>localStorage.getItem('tl_pushkey')===VAPID_PUBLIC,null,{timeout:15000})
   .catch(()=>{ throw new Error('stale push key was never healed'); });
 if(unsubEp!=='https://push.example/old') throw new Error('stale sub not retired server-side: '+unsubEp);
 if(resubEp!=='https://push.example/fresh') throw new Error('did not re-subscribe with the new key: '+resubEp);
 console.log('rotated VAPID key: stale sub dropped + re-subscribed on boot OK');

 // 6) iPhone in a Safari TAB: the push API is absent, so the card used to
 // vanish entirely — it must stay and say how to get notifications instead.
 const ios = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, serviceWorkers:'block',
   userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
 const pgi = await ios.newPage();
 await pgi.addInitScript(()=>{ try{ delete window.PushManager; }catch(e){}
   try{ Object.defineProperty(window,'Notification',{ configurable:true, get:()=>undefined }); }catch(e){}
   try{ localStorage.setItem('tl_nick','Sam'); }catch(e){} });
 await pgi.route(/lb\.test|workers\.dev/, r=>r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({me:null,friends:[],requests:[],outgoing:0,inbox:[]})}));
 await pgi.goto('http://localhost:8099/',{waitUntil:'load'}); await pgi.waitForTimeout(500);
 await pgi.evaluate(()=>goTab('profile')); await pgi.waitForTimeout(400);
 const iosCard = await pgi.$eval('#app', e=>e.innerText);
 if(!/Notifications/.test(iosCard)) throw new Error('notifications card hidden on iOS Safari');
 if(!/Add to Home Screen/.test(iosCard)) throw new Error('no Home Screen instruction on iOS: '+iosCard.slice(0,400));
 if(/Turn on/.test(iosCard.split('Notifications')[1]||'')) throw new Error('offered a toggle that cannot work');
 console.log('iOS Safari tab: card kept + Add to Home Screen instruction OK');
 await ios.close();

 console.log('PUSH CLIENT TEST PASS ✓');
 await b.close(); srv.close();
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
