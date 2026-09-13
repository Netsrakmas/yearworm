// Behavior checks for the compact UI. No browser, network, or extra dependencies.
const assert = require('node:assert/strict');
const { game } = require('./deck-region');
let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push([name,fn]);
}

// Check disclosure ancestry on rendered templates, including tags with > in handlers.
function visible(html, needle) {
  const stack=[];
  for(const m of html.matchAll(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g)) {
    const tag=m[0], name=tag.match(/^<\/?([\w-]+)/)?.[1];
    if(!name) continue;
    if(tag.startsWith('</')) { stack.pop(); continue; }
    const hidden=/\shidden(?:\s|>)/.test(tag) || /style="[^"]*display:\s*none/.test(tag);
    if(tag.includes(needle)) return !hidden && !stack.some(s=>s.hidden || s.closed);
    if(!/\/$/.test(tag.slice(0,-1)) && !['input','img','br','hr','meta','link'].includes(name)) {
      stack.push({hidden, closed:name==='details' && !/\sopen(?:\s|>)/.test(tag)});
    }
  }
  return false;
}

test('combining decks updates both the selection summary and playable songs', () => {
  const g = game();
  g.run('openMode("survival"); S.selectedIds=["party"]; toggleDeck("classicrock");');
  assert.deepEqual(g.json('S.selectedIds'), ['party', 'classicrock']);
  assert.equal(g.nodes.get('selectedDeckSummary').textContent,
    g.run('selectedDeckSummary()'));
  assert.match(g.nodes.get('selectedDeckSummary').textContent, /Classic Rock/);
  assert.ok(g.run('selectedSongs().length') > g.run('DECKS.find(d=>d.id==="party").songs.length'));
  g.run('toggleDeck("party"); toggleDeck("classicrock");');
  assert.equal(g.nodes.get('selectedDeckSummary').textContent, 'Choose a deck');
  assert.equal(g.run('selectedSongs().length'), 0);
});

test('a settings rerender preserves expanded sections after DOM replacement', () => {
  const g = game();
  g.run('_tab="profile"; renderSetup(); document.querySelectorAll=()=>[{id:"musicSettings"}];');
  const root = g.nodes.get('app');
  let markup = root.innerHTML;
  Object.defineProperty(root, 'innerHTML', { get: () => markup, set(value) {
    markup=value; g.nodes.clear(); g.nodes.set('app', root);
  }});
  g.run('setDutchDeckPreference("show")');
  assert.match(markup, /id="profileSettings"/);
  assert.match(markup, /id="musicSettings"/);
  assert(visible(markup, 'id="profileSettings"'));
  assert(visible(markup, 'id="chalDeckRow"'));
  assert(visible(markup, 'id="gsiBtn"'));
  assert.equal(g.nodes.get('musicSettings').open, true);
  assert.ok(g.json('S.selectedIds').includes('top10'));
});

test('friend refresh preserves an unfinished name search and code', () => {
  const g = game();
  g.run(`_social={me:{id:'me',handle:'Me',code:'YW-ABCDEF'},friends:[]}; renderFriendsCard(_social);
    document.getElementById('addFriendPanel').open=true;
    document.getElementById('findIn').value='Sam';
    document.getElementById('codeIn').value='YW-123';
    document.getElementById('findOut').innerHTML='<b>Sam</b>';`);
  const card = g.nodes.get('friendsCard');
  Object.defineProperty(card, 'innerHTML', { set() {
    for(const id of ['addFriendPanel','findIn','codeIn','findOut']) g.nodes.delete(id);
  }});
  g.run('renderFriendsCard(_social)');
  assert.equal(g.nodes.get('addFriendPanel').open, true);
  assert.equal(g.nodes.get('findIn').value, 'Sam');
  assert.equal(g.nodes.get('codeIn').value, 'YW-123');
  assert.equal(g.nodes.get('findOut').innerHTML, '<b>Sam</b>');
});

test('all rankings stay visible and paint asynchronously received boards', () => {
  const g = game();
  g.run('_tab="ranks"; renderSetup();');
  const markup = g.nodes.get('app').innerHTML;
  for(const id of ['ranksDaily','ranksSurvDay','ranksSurv7','ranksSurvFrWrap','ranksFriends']) {
    assert(visible(markup, `id="${id}"`), id + ' must not be hidden by filters or disclosures');
  }
  g.run('_boards.s1={top:[]}; _boards.s7={top:[{nick:"Week winner",score:20}],win:7,total:1}; _boards.daily={top:[{nick:"Daily winner",score:5}],total:1}; paintRanks();');
  assert.match(g.nodes.get('ranksSurvDay').innerHTML, /No survival runs yet today/);
  assert.match(g.nodes.get('ranksSurv7').innerHTML, /Week winner/);
  assert.match(g.nodes.get('ranksDaily').innerHTML, /Daily winner/);
});

test('audio events update truthful status without rebuilding the playing screen', () => {
  const g = game();
  g.run(`S.mode='daily'; S.players=[{name:'Sam',timeline:[{year:1980,name:'Anchor',artist:'Artist'}]}];
    S.turn=0; S.current={}; S.playing=true; renderGame();`);
  assert.match(g.nodes.get('app').innerHTML, /id="playbackStatus" role="status">Playing/);
  for(const [state, status] of [
    ['S.buffering=true; syncBuffer()', 'Buffering…'],
    ['S.playing=false; syncEq()', 'Paused'],
    ['S.checkingTrack=true; syncEq()', 'Checking track…'],
    ['S.checkingTrack=false; S.current=null; syncEq()', 'Loading…'],
  ]) {
    g.run(state); assert.equal(g.nodes.get('playbackStatus').textContent, status);
  }
});
test('results keep replay, setup, and the Play menu as distinct destinations', () => {
  const g = game();
  g.run(`openMode('survival'); S.mode='survival'; S.score=9; S.bestStreak=6; overlayGameOver(false);
    let restarted=0; onStart=()=>restarted++; playAgain();`);
  assert.equal(g.run('restarted'), 1);
  assert.equal(g.run('loadBest().cards'), 9);
  g.run('backToSetup()');
  assert.match(g.nodes.get('app').innerHTML, /id="modeDeckPicker"/);
  g.run(`_tab='friends'; backToMenu()`);
  assert.equal(g.run('_tab'), 'play');
  assert.equal(g.run('_playScreen'), null);
  assert.match(g.nodes.get('app').innerHTML, /class="modelist"/);
});
test('closing Add friend survives a refresh, while its action stays above friends', () => {
  const g=game();
  g.run(`_social={me:{id:'me',handle:'Me',code:'YW-ABCDEF'},friends:[]};
    document.getElementById('addFriendPanel').open=false; renderFriendsCard(_social);`);
  assert.equal(g.nodes.get('addFriendPanel').open,false);
  g.run(`_social.friends=[{id:'friend',handle:'LongFriendName',w:1}];`);
  const markup=g.run('friendsCardHTML(_social)');
  assert(markup.indexOf('id="addFriendPanel"') < markup.indexOf('LongFriendName'));
});

test('outgoing challenge music is chosen before starting and keeps the selected recipient', async () => {
  const g=game();
  g.run(`let starts=0, chosenDeck='';
    startFreshChallenge=async()=>{ starts++; chosenDeck=chalDeckId(); S.chalTarget=null; };
    _social={friends:[]}; openChallengePicker();`);
  assert.equal(g.run('starts'),0);
  assert(visible(g.nodes.get('sheet').innerHTML,'id="challengeDeck"'));
  g.run(`store.set('tl_chaldeck','classicrock'); _social.friends=[{id:'friend',handle:'Sam'}]; challengeFriend('friend');`);
  assert.equal(g.run('starts'),0);
  await g.run(`startFriendChallenge('friend')`);
  assert.equal(g.run('chosenDeck'),'classicrock');
  assert.deepEqual(g.json('S.chalTarget'),{user:'friend',handle:'Sam'});
});

test('final answers are visible before actions for tutorial, Daily, Turbo and challenges', () => {
  for(const mode of ['tut','daily','classic','challenge','multiplayer']) {
    const g=game();
    g.run(`renderGame=()=>{}; confettiBurst=()=>{}; S.mode=${JSON.stringify(mode==='multiplayer'?'classic':mode)};
      S.players=[{name:'Sam',timeline:[],hits:2,tries:5,results:[1,0,1,0,0],timeMs:25000}];
      S.runCards=[1,2,3,4,5]; S.runLog=[{ok:false,year:1984,name:'Final song',artist:'Artist'}];
      S.lastReveal={correct:false,id:'it123',year:1984,name:'Final song',artist:'Artist'};`);
    if(mode==='multiplayer') g.run(`S.players.push({name:'Friend',timeline:[],hits:1,tries:5})`);
    g.run('overlayRunOver()');
    const html=g.nodes.get('sheet').innerHTML;
    assert(visible(html,'class="final-answer"'),mode);
    assert(html.indexOf('Final song') < html.indexOf('class="result-actions"'),mode);
    if(mode!=='tut') assert(visible(html,'class="report-yr"'),mode);
  }
});

test('friend results show standings and reactions, and cancelling rematch restores them once', () => {
  const g=game();
  g.run(`renderGame=()=>{}; confettiBurst=()=>{};
    _social={friends:[{id:'friend',handle:'Sam'}]}; S.mode='challenge';
    S.players=[{name:'Me',timeline:[],hits:2,tries:5,results:[1,0,1,0,0],timeMs:25000}];
    S.runCards=[1,2,3,4,5]; S.challenge={idx:[1,2,3,4,5],beat:3,msgId:7,fromHandle:'Sam'};
    S.reactTo={user:'friend',handle:'Sam',msgId:7};
    overlayRunOver();`);
  const result=g.nodes.get('sheet').innerHTML, games=g.run('loadLife().games');
  assert(visible(result,'id="chalBoard"'));
  assert(visible(result,'id="reactRow"'));
  g.run(`challengeFriend('friend',true); cancelChallengePicker()`);
  assert.equal(g.nodes.get('sheet').innerHTML,result);
  assert.equal(g.run('loadLife().games'),games);
});

test('Google sign-in refreshes the visible Profile identity and linked status', async () => {
  const g=game();
  g.run(`_tab='profile'; fetch=async()=>({ok:true,json:async()=>({me:{id:'me',handle:'Linked Sam',linked:true,code:'YW-ABCDEF'}})});`);
  await g.run(`onGoogleCred({credential:'test-only'})`);
  const markup=g.nodes.get('app').innerHTML;
  assert.match(markup,/value="Linked Sam"/);
  assert.match(markup,/Google linked/);
  assert.doesNotMatch(markup,/id="gsiBtn"/);
});

(async()=>{
  for(const [name,fn] of cases){ await fn(); console.log('PASS '+name); passed++; }
  console.log(`INTERFACE REGRESSION: ${passed} tests passed`);
})().catch(error=>{ console.error(error); process.exitCode=1; });
