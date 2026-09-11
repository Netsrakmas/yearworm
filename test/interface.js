// Behavior checks for the compact UI. No browser, network, or extra dependencies.
const assert = require('node:assert/strict');
const { game } = require('./deck-region');
let passed = 0;
function test(name, fn) {
  fn(); console.log('PASS ' + name); passed++;
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
  g.run('_tab="profile"; renderSetup(); document.querySelectorAll=()=>[{id:"profileSettings"},{id:"musicSettings"}];');
  const root = g.nodes.get('app');
  let markup = root.innerHTML;
  Object.defineProperty(root, 'innerHTML', { get: () => markup, set(value) {
    markup=value; g.nodes.clear(); g.nodes.set('app', root);
  }});
  g.run('setDutchDeckPreference("show")');
  assert.match(markup, /id="profileSettings"/);
  assert.match(markup, /id="musicSettings"/);
  assert.equal(g.nodes.get('profileSettings').open, true);
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

test('rank filters retain the selected period and paint asynchronously received boards', () => {
  const g = game();
  g.run('_tab="ranks"; renderSetup(); setRankView("survival"); setRankWindow(1);');
  let markup = g.nodes.get('app').innerHTML;
  assert.match(markup, /id="rankView-survival" aria-pressed="true"/);
  assert.match(markup, /id="ranksSurv7" hidden/);
  assert.doesNotMatch(markup, /id="ranksSurvDay" hidden/);
  g.run('_boards.s1={top:[]}; paintRanks();');
  assert.match(g.nodes.get('ranksSurvDay').innerHTML, /No survival runs yet today/);
  g.run('setRankView("daily"); setRankView("survival");');
  markup=g.nodes.get('app').innerHTML;
  assert.match(markup, /id="rankWindow-1" aria-pressed="true"/);
  g.run('setRankWindow(42); setRankView("invalid");');
  assert.equal(g.run('_rankWindow'), 1);
  assert.equal(g.run('_rankView'), 'survival');
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
console.log(`INTERFACE REGRESSION: ${passed} tests passed`);
