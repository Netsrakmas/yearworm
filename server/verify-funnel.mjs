// CI-only production schema check: prints metadata, never player rows.
import fs from 'node:fs';
const config=fs.readFileSync(new URL('./wrangler.toml',import.meta.url),'utf8');
const database=config.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const token=process.env.CLOUDFLARE_API_TOKEN?.trim();
if(!database || database==='PASTE_DATABASE_ID_HERE' || !account || !token) throw Error('Missing deployment configuration');
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,{
  method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({sql:'PRAGMA table_info(funnel)'})
});
if(!response.ok) throw Error(`D1 schema check HTTP ${response.status}`);
const body=await response.json();
if(!body.success || !body.result?.[0]?.success) throw Error('D1 schema query failed');
const cols=body.result[0].results;
if(cols.map(c=>c.name).sort().join(',')!=='day,n,step') throw Error('Unexpected funnel columns');
if(!cols.some(c=>c.name==='day' && c.pk===1) || !cols.some(c=>c.name==='step' && c.pk===2)) throw Error('Funnel primary key must be day,step');
console.log('Production D1 funnel verified: day, step, n; primary key (day, step). No player data queried.');
