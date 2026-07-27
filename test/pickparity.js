// The version-picking rules exist TWICE: in the Worker (which decides for
// everyone and pins the result) and in index.html (used only when the Worker
// can't be reached and the phone goes straight to Apple). If those two ever
// disagree, a player hears a different recording depending on which path
// answered — silently, and for weeks. This extracts BOTH copies from the real
// sources and runs them over the same fixtures.
const fs = require('fs');
const vm = require('vm');

const ROOT = '/home/user/Timeline';

function loadClientPicker(){
  const h = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const start = h.indexOf('const BADVER =');
  const end = h.indexOf('\n}', h.indexOf('function pickBest(results, song){')) + 2;
  if(start < 0 || end < 2) throw new Error('could not find the picker in index.html');
  const src = `function norm(s){ return (s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function yearOf(d){ const y = parseInt(String(d||"").slice(0,4),10); return y||null; }
` + h.slice(start, end) + '\nmodule.exports = { pickBest, BADVER, NOVOCAL, OFFVER, LONGVER };';
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(src, ctx);
  return ctx.module.exports;
}
function loadWorkerPicker(){
  const w = fs.readFileSync(ROOT + '/server/worker.js', 'utf8');
  const start = w.indexOf('function norm(s){');
  const end = w.indexOf('\n}', w.indexOf('function pickBest(results, song){')) + 2;
  if(start < 0 || end < 2) throw new Error('could not find the picker in worker.js');
  const src = w.slice(start, end) + '\nmodule.exports = { pickBest, BADVER, NOVOCAL, OFFVER, LONGVER };';
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(src, ctx);
  return ctx.module.exports;
}

const R = (o) => Object.assign({ previewUrl: 'https://p/' + (o.trackId || 1) + '.m4a' }, o);

// each case is a real failure mode this project has actually shipped
const CASES = [
  { name: 'exact title + artist wins',
    song: { title: 'Waterloo', artist: 'ABBA', year: 1974 },
    results: [ R({trackId:1, trackName:'Waterloo (Live)', artistName:'ABBA', releaseDate:'1999-01-01'}),
               R({trackId:2, trackName:'Waterloo', artistName:'ABBA', releaseDate:'1974-01-01', trackTimeMillis:167000}) ] },
  { name: 'karaoke rejected outright',
    song: { title: 'Africa', artist: 'Toto', year: 1982 },
    results: [ R({trackId:3, trackName:'Africa', artistName:'Karaoke Stars', releaseDate:'1982-01-01'}),
               R({trackId:4, trackName:'Africa', artistName:'Toto', releaseDate:'1982-01-01', trackTimeMillis:295000}) ] },
  { name: 'instrumental rejected (no voice to recognise)',
    song: { title: 'Smooth', artist: 'Santana', year: 1999 },
    results: [ R({trackId:5, trackName:'Smooth (Instrumental)', artistName:'Santana', releaseDate:'1999-01-01'}),
               R({trackId:6, trackName:'Smooth', artistName:'Santana', releaseDate:'1999-01-01', trackTimeMillis:294000}) ] },
  { name: 'live album cut loses to the studio take (the Silver Springs bug)',
    song: { title: 'Silver Springs', artist: 'Fleetwood Mac', year: 1977 },
    results: [ R({trackId:7, trackName:'Silver Springs (Live)', artistName:'Fleetwood Mac', collectionName:'The Dance', releaseDate:'1997-08-19', trackTimeMillis:280000}),
               R({trackId:8, trackName:'Silver Springs', artistName:'Fleetwood Mac', releaseDate:'1977-02-04', trackTimeMillis:268000}) ] },
  { name: 'radio edit beats the 12" mix (the Temperer bug)',
    song: { title: 'Feel It', artist: 'The Tamperer', year: 1998 },
    results: [ R({trackId:9, trackName:'Feel It (Extended Mix)', artistName:'The Tamperer', releaseDate:'1998-01-01', trackTimeMillis:430000}),
               R({trackId:10, trackName:'Feel It (Radio Edit)', artistName:'The Tamperer', releaseDate:'1998-01-01', trackTimeMillis:200000}) ] },
  { name: 'shorter unrelated title must not hijack (Move It! vs I Like to Move It)',
    song: { title: 'I Like to Move It', artist: 'Reel 2 Real', year: 1993 },
    results: [ R({trackId:11, trackName:'Move It!', artistName:'Reel 2 Real', releaseDate:'1993-01-01'}),
               R({trackId:12, trackName:'I Like to Move It (feat. The Mad Stuntman)', artistName:'Reel 2 Real', releaseDate:'1993-01-01', trackTimeMillis:230000}) ] },
  { name: 'artist-only match is refused (wrong song beats no song? no)',
    song: { title: 'Zombie', artist: 'The Cranberries', year: 1994 },
    results: [ R({trackId:13, trackName:'Linger', artistName:'The Cranberries', releaseDate:'1993-01-01'}) ] },
  { name: 'era bonus separates a reissue from the original',
    song: { title: 'Blue Monday', artist: 'New Order', year: 1983 },
    results: [ R({trackId:14, trackName:'Blue Monday', artistName:'New Order', collectionName:'2010 Mixes', releaseDate:'2010-01-01', trackTimeMillis:270000}),
               R({trackId:15, trackName:'Blue Monday', artistName:'New Order', releaseDate:'1983-03-07', trackTimeMillis:270000}) ] },
  { name: 'a live cut still beats nothing at all',
    song: { title: 'Rosanna', artist: 'Toto', year: 1982 },
    results: [ R({trackId:16, trackName:'Rosanna (Live)', artistName:'Toto', releaseDate:'1990-01-01', trackTimeMillis:300000}) ] },
  { name: 'wanted "Live" in the curated title is not penalised',
    song: { title: 'Live Is Life', artist: 'Opus', year: 1985 },
    results: [ R({trackId:17, trackName:'Live Is Life', artistName:'Opus', releaseDate:'1985-01-01', trackTimeMillis:250000}) ] },
  { name: 'no previewUrl is unusable',
    song: { title: 'Yesterday', artist: 'The Beatles', year: 1965 },
    results: [ { trackId:18, trackName:'Yesterday', artistName:'The Beatles', releaseDate:'1965-01-01' } ] },
  { name: 'empty result set',
    song: { title: 'Nothing', artist: 'Nobody', year: 2000 }, results: [] },
];

(async()=>{
  const client = loadClientPicker();
  const worker = loadWorkerPicker();

  // the rule sets themselves must be character-identical, not merely similar
  for(const re of ['BADVER','NOVOCAL','OFFVER','LONGVER']){
    if(String(client[re]) !== String(worker[re]))
      throw new Error(re + ' differs:\n  client: ' + client[re] + '\n  worker: ' + worker[re]);
  }
  console.log('filter patterns identical in both copies OK');

  let mismatches = 0;
  for(const c of CASES){
    const a = client.pickBest(c.results, c.song);
    const b = worker.pickBest(c.results, c.song);
    const ai = a ? a.trackId : null, bi = b ? b.trackId : null;
    if(ai !== bi){ mismatches++; console.log('  ✗ ' + c.name + ' — client:' + ai + ' worker:' + bi); }
  }
  if(mismatches) throw new Error(mismatches + ' case(s) where the two copies disagree');
  console.log('both copies agree on all ' + CASES.length + ' fixtures OK');

  // and the picks are actually RIGHT, not just consistently wrong
  const expect = { 'exact title + artist wins':2, 'karaoke rejected outright':4,
    'instrumental rejected (no voice to recognise)':6,
    'live album cut loses to the studio take (the Silver Springs bug)':8,
    'radio edit beats the 12" mix (the Temperer bug)':10,
    'shorter unrelated title must not hijack (Move It! vs I Like to Move It)':12,
    'artist-only match is refused (wrong song beats no song? no)':null,
    'era bonus separates a reissue from the original':15,
    'a live cut still beats nothing at all':16,
    'wanted "Live" in the curated title is not penalised':17,
    'no previewUrl is unusable':null, 'empty result set':null };
  for(const c of CASES){
    const got = worker.pickBest(c.results, c.song);
    const gi = got ? got.trackId : null;
    if(gi !== expect[c.name]) throw new Error('wrong pick for "' + c.name + '": expected ' + expect[c.name] + ', got ' + gi);
  }
  console.log('every fixture resolves to the RIGHT track OK');
  console.log('PICK PARITY TEST PASS ✓');
})().catch(e=>{ console.error('PICK PARITY FAIL ✗', e.message); process.exit(1); });
