// Read-only production checks. Never log keys, authorization headers or metrics.
const base=process.env.WORKER_URL;
const key=process.env.STATS_KEY;
if(!base || !key) throw Error('Missing smoke-test configuration');
const check=(ok,message)=>{if(!ok) throw Error(message);};
const health=await fetch(base+'/health');
check(health.ok && (await health.json()).ok===true,'Health check failed');
for(const headers of [{}, {Authorization:'Bearer invalid-smoke-test-key'}]){
  const r=await fetch(base+'/stats?json=1',{headers});
  check(r.status===401,'Stats must reject missing/wrong credentials');
  check(r.headers.get('Cache-Control')?.includes('no-store'),'Stats errors must not be cached');
}
const headers={Authorization:`Bearer ${key}`};
const r=await fetch(base+'/stats?json=1',{headers});
check(r.status===200,'Authenticated stats unavailable');
check(r.headers.get('Cache-Control')?.includes('no-store'),'Stats must not be cached');
check(!r.headers.has('Access-Control-Allow-Origin'),'Stats must not expose cross-origin access');
const stats=await r.json();
check(stats.funnel?.available===true,'Production funnel table unavailable');
check(typeof stats.funnel.fresh.secondStart==='number','Second-game metric missing');
for(const k of ['shared','opened','played']) check(typeof stats.funnel.challenges[k]==='number','Challenge metric missing');
// Recursively require only numeric / boolean leaves: no names, emails, tokens,
// individual scores or URLs can accidentally appear as string values.
function aggregates(value){
  if(value && typeof value==='object') return Object.values(value).every(aggregates);
  return typeof value==='number' || typeof value==='boolean';
}
check(aggregates(stats),'Stats response contains unexpected non-aggregate values');
const html=await fetch(base+'/stats',{headers:{Authorization:'Basic '+Buffer.from('stats:'+key).toString('base64')}});
check(html.status===200,'Browser Basic authentication failed');
check(html.headers.get('Referrer-Policy')==='no-referrer','Dashboard referrer protection missing');
const text=await html.text();
check(text.includes('Shared challenges') && text.includes('started a second game'),'Dashboard measurements missing');
check(!text.includes(key),'Dashboard must not contain the secret');
console.log('Production health, auth denial, Basic/Bearer access, private headers, D1 availability and aggregate-only metrics verified. No test events sent.');
