/*
 * UI and game-flow controller for Shogi vs Chess.
 * Depends on ShogiChess (src/rules.js) and SvcNet (src/net.js).
 *
 * Responsibilities: board rendering and interaction, local / online play,
 * Fischer clocks, game records (saved in localStorage) with a replay viewer,
 * and shareable game-record URLs.
 */
(function () {
  'use strict';

  const S = ShogiChess;
  const $ = (id) => document.getElementById(id);

  const REASONS = {
    checkmate: '詰み',
    stalemate: '合法手なし（ステイルメイト）',
    resign: '投了',
    repetition: '千日手',
    timeout: '時間切れ',
  };
  const SIDE_NAME = ['将棋（先手）', 'チェス（後手）'];
  const SIDE_MARK = ['☗', '☖'];
  const RECORDS_KEY = 'svc-records';
  const MAX_RECORDS = 200;

  const app = {
    game: S.newGame(),
    history: [],
    mode: 'local',
    mySide: null,
    flipped: false,
    selected: null,
    net: null,
    role: null,
    roomId: null,
    peerConnected: false,
    hostSide: 0,
    pendingPromo: null,
    clock: { tc: null, times: [0, 0], running: null, lastTick: 0 },
    recordId: null,
    review: null,
  };

  // ---------- Helpers ----------

  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms || 2500);
  }

  function canAct(owner) {
    const g = app.game;
    if (app.review || g.status.over || g.turn !== owner) return false;
    if (app.mode === 'local') return true;
    return app.mySide === owner && app.peerConnected;
  }

  function endTokenText(tok) {
    const side = Number(tok[1]);
    return SIDE_MARK[side] + (tok[0] === 'T' ? '時間切れ' : '投了');
  }

  // Replay an encoded record, collecting every intermediate state and move text.
  function replay(encoded) {
    let st = S.newGame();
    const states = [st];
    const texts = [];
    for (const tok of (encoded || '').split(',')) {
      if (!tok) continue;
      if (tok[0] === 'R' || tok[0] === 'T') {
        texts.push(endTokenText(tok));
        st = S.endGame(st, Number(tok[1]), tok[0] === 'T' ? 'timeout' : 'resign');
      } else {
        const m = S.findLegal(st, tok);
        if (!m) throw new Error('bad move in record: ' + tok);
        texts.push(S.moveToText(st, m));
        st = S.applyMove(st, m);
      }
      states.push(st);
    }
    return { states: states, texts: texts, state: st };
  }

  function loadEncoded(encoded) {
    const r = replay(encoded);
    app.game = r.state;
    app.history = r.texts;
    app.selected = null;
  }

  function updateHash() {
    if (app.mode !== 'local') return;
    const enc = S.encodeGame(app.game);
    const url = location.pathname + location.search + (enc ? '#g=' + enc : '');
    history.replaceState(null, '', url);
  }

  function hostStorageKey(roomId) { return 'svc-host:' + roomId; }

  function saveHostState() {
    if (app.role !== 'host' || !app.roomId) return;
    try {
      localStorage.setItem(hostStorageKey(app.roomId), JSON.stringify({
        side: app.hostSide, game: S.encodeGame(app.game), clock: clockSnapshot(), recordId: app.recordId,
      }));
    } catch (e) { /* ignore */ }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => toast('コピーしました'), () => fallbackCopy(text));
    }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('コピーしました'); } catch (e) { toast('コピーできませんでした'); }
    document.body.removeChild(ta);
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- Clock (Fischer) ----------

  function selectedTimeControl() {
    const v = $('tc-select').value;
    if (v === 'custom') {
      const base = Math.max(1, Number($('tc-base').value) || 10) * 60;
      const inc = Math.max(0, Number($('tc-inc').value) || 0);
      return { base: base, inc: inc };
    }
    const parts = v.split(',').map(Number);
    if (!parts[0]) return null;
    return { base: parts[0], inc: parts[1] || 0 };
  }

  function tcText(tc) {
    if (!tc) return '持ち時間なし';
    const min = tc.base / 60;
    return (Number.isInteger(min) ? min : min.toFixed(1)) + '分 + ' + tc.inc + '秒';
  }

  function resetClock(tc) {
    app.clock = { tc: tc || null, times: tc ? [tc.base * 1000, tc.base * 1000] : [0, 0], running: null, lastTick: 0 };
  }

  function clockSnapshot() {
    tickClock();
    return { tc: app.clock.tc, times: app.clock.times.slice(), running: app.clock.running };
  }

  function restoreClock(snap) {
    if (!snap || !snap.tc) { resetClock(null); return; }
    app.clock = { tc: snap.tc, times: [Number(snap.times[0]) || 0, Number(snap.times[1]) || 0], running: null, lastTick: Date.now() };
    if (!app.game.status.over && app.game.moves.length > 0) app.clock.running = app.game.turn;
  }

  // Subtract elapsed time from the running clock. Returns true if a flag fell.
  function tickClock() {
    const c = app.clock;
    if (!c.tc || c.running === null) return false;
    const now = Date.now();
    c.times[c.running] = Math.max(0, c.times[c.running] - (now - c.lastTick));
    c.lastTick = now;
    if (c.times[c.running] === 0) {
      const loser = c.running;
      c.running = null;
      onFlag(loser);
      return true;
    }
    return false;
  }

  // Called when a move is played: add the increment to the mover and start the opponent's clock.
  function clockAfterMove(mover, skipIncrement) {
    const c = app.clock;
    if (!c.tc) return;
    if (c.running === mover && !skipIncrement) c.times[mover] += c.tc.inc * 1000;
    c.running = app.game.status.over ? null : app.game.turn;
    c.lastTick = Date.now();
  }

  function onFlag(loser) {
    if (app.game.status.over) return;
    app.game = S.timeout(app.game, loser);
    app.history.push(SIDE_MARK[loser] + '時間切れ');
    app.selected = null;
    if (app.net) app.net.send({ t: 'flag', side: loser, times: app.clock.times.slice() });
    afterChange();
  }

  function formatClock(ms) {
    const total = Math.max(0, ms);
    const s = Math.floor(total / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (total < 10000) return m + ':' + String(sec).padStart(2, '0') + '.' + Math.floor((total % 1000) / 100);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function renderClocks() {
    const c = app.clock;
    for (const owner of [0, 1]) {
      const el = app.clockEls && app.clockEls[owner];
      if (!el) continue;
      if (!c.tc) { el.classList.add('hidden'); continue; }
      el.classList.remove('hidden');
      el.textContent = formatClock(c.times[owner]);
      const over = app.game.status.over;
      el.classList.toggle('running', !over && c.running === owner);
      el.classList.toggle('low', !over && c.times[owner] < 20000 && c.times[owner] > 0);
      el.classList.toggle('flag', c.times[owner] === 0);
    }
  }

  setInterval(() => {
    if (app.game.status.over) return;
    if (tickClock()) return; // afterChange() already rendered
    renderClocks();
  }, 100);

  // ---------- Rendering ----------

  function viewState() {
    return app.review ? app.review.states[app.review.index] : app.game;
  }

  function pieceEl(p) {
    const el = document.createElement('div');
    const shogi = S.isShogiType(p.t);
    el.className = 'piece ' + (shogi ? 'shogi' : 'chess') + ' owner' + p.o;
    if (shogi) {
      el.textContent = S.pieceName(p);
      if (el.textContent.length > 1) el.dataset.long = '1';
      if (p.pr) el.classList.add('promoted');
      if (p.t === 'OU') el.classList.add('king');
      const upright = (p.o === S.SENTE) !== app.flipped;
      if (!upright) el.classList.add('rotated');
    } else {
      el.textContent = S.CHESS_GLYPHS[p.t][p.o === S.SENTE ? 0 : 1];
      if (p.t === 'k') el.classList.add('king');
    }
    return el;
  }

  function handGlyph(t) {
    if (S.isShogiType(t)) return S.NAMES[t];
    return S.CHESS_GLYPHS[t][1];
  }

  function targetsOfSelection() {
    const g = app.game;
    if (!app.selected || app.review) return [];
    if (app.selected.kind === 'sq') return S.legalMovesFrom(g, app.selected.r, app.selected.c);
    return S.legalDrops(g, app.selected.piece);
  }

  function render() {
    renderBoard();
    renderHands();
    renderClocks();
    renderStatus();
    renderMoves();
    renderButtons();
    renderReviewBar();
  }

  function renderBoard() {
    const g = viewState();
    const board = $('board');
    board.innerHTML = '';
    const targets = targetsOfSelection();
    const targetKey = {};
    for (const m of targets) targetKey[m.to[0] + ',' + m.to[1]] = true;
    const last = g.lastMove;
    const king = g.inCheck ? S.findKing(g.board, g.turn) : null;

    for (let i = 0; i < S.N; i++) {
      for (let j = 0; j < S.N; j++) {
        const r = app.flipped ? S.N - 1 - i : i;
        const c = app.flipped ? S.N - 1 - j : j;
        const cell = document.createElement('div');
        cell.className = 'cell';
        if ((r === 2 || r === 5) && (c === 2 || c === 5)) cell.classList.add('star');
        const p = g.board[r][c];
        if (p) cell.appendChild(pieceEl(p));
        if (app.selected && app.selected.kind === 'sq' && app.selected.r === r && app.selected.c === c) cell.classList.add('selected');
        if (targetKey[r + ',' + c]) cell.classList.add(p ? 'capture' : 'target');
        if (last && last.kind === 'move' && last.from[0] === r && last.from[1] === c) cell.classList.add('last-from');
        if (last && last.to[0] === r && last.to[1] === c) cell.classList.add('last-to');
        if (king && king[0] === r && king[1] === c) cell.classList.add('in-check');
        cell.addEventListener('click', () => onSquareClick(r, c));
        board.appendChild(cell);
      }
    }

    const files = $('file-labels');
    files.innerHTML = '';
    for (let j = 0; j < S.N; j++) {
      const c = app.flipped ? S.N - 1 - j : j;
      const d = document.createElement('div');
      d.textContent = S.FILE_ZENKAKU[S.N - 1 - c];
      files.appendChild(d);
    }
    const ranks = $('rank-labels');
    ranks.innerHTML = '';
    for (let i = 0; i < S.N; i++) {
      const r = app.flipped ? S.N - 1 - i : i;
      const d = document.createElement('div');
      d.textContent = S.RANK_KANJI[r];
      ranks.appendChild(d);
    }
  }

  function renderHand(el, owner) {
    const g = viewState();
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'hand-head';
    const label = document.createElement('div');
    label.className = 'hand-label';
    label.textContent = SIDE_MARK[owner] + ' ' + SIDE_NAME[owner] + ' の持ち駒';
    if (app.mode === 'online' && app.mySide === owner) label.textContent += '（あなた）';
    head.appendChild(label);
    const clock = document.createElement('div');
    clock.className = 'clock hidden';
    head.appendChild(clock);
    app.clockEls = app.clockEls || [];
    app.clockEls[owner] = clock;
    el.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'chips';
    const hand = g.hands[owner];
    let any = false;
    for (const t of S.HAND_ORDER) {
      if (!hand[t]) continue;
      any = true;
      const chip = document.createElement('button');
      chip.className = 'chip ' + (S.isShogiType(t) ? 'shogi' : 'chess') + ' owner' + owner;
      chip.innerHTML = '<span class="glyph">' + handGlyph(t) + '</span><span class="count">' + hand[t] + '</span>';
      chip.title = S.NAMES[t];
      if (app.selected && app.selected.kind === 'hand' && app.selected.owner === owner && app.selected.piece === t) chip.classList.add('selected');
      chip.disabled = !canAct(owner);
      chip.addEventListener('click', () => onHandClick(owner, t));
      chips.appendChild(chip);
    }
    if (!any) {
      const none = document.createElement('span');
      none.className = 'none';
      none.textContent = 'なし';
      chips.appendChild(none);
    }
    el.appendChild(chips);
  }

  function renderHands() {
    const top = app.flipped ? S.SENTE : S.GOTE;
    renderHand($('hand-top'), top);
    renderHand($('hand-bottom'), 1 - top);
  }

  function renderStatus() {
    const g = app.game;
    const main = $('status-main');
    const sub = $('status-sub');
    const card = $('status-card');
    card.className = 'status-card';
    if (app.review) {
      card.classList.add('over');
      main.textContent = '棋譜の再生中: ' + app.review.title;
      sub.textContent = app.review.index + ' / ' + (app.review.states.length - 1) + '手';
      return;
    }
    if (g.status.over) {
      card.classList.add('over');
      if (g.status.winner === null) {
        main.textContent = '引き分け';
        sub.textContent = REASONS[g.status.reason] || g.status.reason;
      } else {
        const w = g.status.winner;
        main.textContent = SIDE_MARK[w] + SIDE_NAME[w] + 'の勝ち';
        let why = REASONS[g.status.reason] || g.status.reason;
        if (app.mode === 'online') why += app.mySide === w ? ' — あなたの勝ちです！' : ' — あなたの負けです';
        sub.textContent = why;
      }
      return;
    }
    const t = g.turn;
    if (app.mode === 'online') {
      if (app.mySide === t) { main.textContent = 'あなたの手番 ' + SIDE_MARK[t] + SIDE_NAME[t]; card.classList.add('mine'); }
      else main.textContent = '相手の手番 ' + SIDE_MARK[t] + SIDE_NAME[t];
    } else {
      main.textContent = SIDE_MARK[t] + SIDE_NAME[t] + 'の手番';
    }
    sub.textContent = (g.inCheck ? '王手！ ' : '') + g.moves.length + '手目 ・ ' + tcText(app.clock.tc);
    if (g.inCheck) card.classList.add('check');
  }

  function renderMoves() {
    const ol = $('moves');
    ol.innerHTML = '';
    const texts = app.review ? app.review.texts : app.history;
    const current = app.review ? app.review.index - 1 : texts.length - 1;
    texts.forEach((text, i) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (i === current) li.classList.add('current');
      if (app.review) {
        li.classList.add('clickable');
        li.addEventListener('click', () => reviewGo(i + 1));
      }
      ol.appendChild(li);
    });
    const cur = ol.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function renderButtons() {
    const g = app.game;
    const online = app.mode === 'online';
    $('mode-card').classList.toggle('hidden', online);
    $('online-card').classList.toggle('hidden', !online);
    $('btn-resign').disabled = !!app.review || g.status.over || (online && (!app.peerConnected || app.mySide === null));
    $('btn-rematch').disabled = !!app.review || (online && !app.peerConnected);
    $('btn-rematch').textContent = online ? '再戦（先後交代）' : '新しい対局';
    $('btn-save-record').disabled = !!app.review || g.moves.length === 0;
  }

  function renderReviewBar() {
    const bar = $('review-bar');
    bar.classList.toggle('hidden', !app.review);
    if (!app.review) return;
    const n = app.review.states.length - 1;
    $('rv-pos').textContent = app.review.index + ' / ' + n + '手';
    $('rv-first').disabled = $('rv-prev').disabled = app.review.index === 0;
    $('rv-last').disabled = $('rv-next').disabled = app.review.index === n;
  }

  // ---------- Interaction ----------

  function onSquareClick(r, c) {
    const g = app.game;
    if (app.pendingPromo || app.review) return;
    const targets = targetsOfSelection().filter((m) => m.to[0] === r && m.to[1] === c);
    if (targets.length) {
      if (targets.length === 1) playMove(targets[0]);
      else askPromotion(targets);
      return;
    }
    const p = g.board[r][c];
    if (p && canAct(p.o)) {
      if (app.selected && app.selected.kind === 'sq' && app.selected.r === r && app.selected.c === c) app.selected = null;
      else app.selected = { kind: 'sq', r: r, c: c };
    } else {
      app.selected = null;
    }
    render();
  }

  function onHandClick(owner, piece) {
    if (!canAct(owner) || app.pendingPromo) return;
    if (app.selected && app.selected.kind === 'hand' && app.selected.piece === piece && app.selected.owner === owner) app.selected = null;
    else app.selected = { kind: 'hand', owner: owner, piece: piece };
    render();
  }

  function askPromotion(variants) {
    app.pendingPromo = variants;
    const overlay = $('promo-overlay');
    const buttons = $('promo-buttons');
    buttons.innerHTML = '';
    const pawn = typeof variants[0].promote === 'string';
    $('promo-title').textContent = pawn ? '昇格する駒を選んでください' : '成りますか？';
    for (const v of variants) {
      const b = document.createElement('button');
      if (pawn) {
        const o = app.game.turn;
        b.className = 'promo-choice';
        b.innerHTML = '<span class="big">' + S.CHESS_GLYPHS[v.promote][o === S.SENTE ? 0 : 1] + '</span><span>' + S.NAMES[v.promote] + '</span>';
      } else {
        b.className = v.promote ? 'primary' : '';
        b.textContent = v.promote ? '成る' : '成らない';
      }
      b.addEventListener('click', () => {
        app.pendingPromo = null;
        overlay.classList.add('hidden');
        playMove(v);
      });
      buttons.appendChild(b);
    }
    overlay.classList.remove('hidden');
  }

  function playMove(move, fromNetwork, netTimes) {
    const g = app.game;
    if (tickClock()) return; // the mover's flag fell first
    const mover = g.turn;
    const text = S.moveToText(g, move);
    app.game = S.applyMove(g, move);
    app.history.push(text);
    app.selected = null;
    // Times sent with a network move already include the mover's increment.
    const synced = !!(fromNetwork && netTimes && app.clock.tc);
    if (synced) app.clock.times = [Number(netTimes[0]) || 0, Number(netTimes[1]) || 0];
    clockAfterMove(mover, synced);
    if (!fromNetwork && app.net) app.net.send({ t: 'move', code: S.encodeMove(move), times: app.clock.times.slice() });
    afterChange();
  }

  function afterChange() {
    updateHash();
    saveHostState();
    if (app.game.status.over) {
      app.clock.running = null;
      autoSaveRecord();
    }
    render();
    if (app.game.status.over) announceResult();
  }

  function announceResult() {
    const st = app.game.status;
    if (st.winner === null) toast('引き分け（' + (REASONS[st.reason] || st.reason) + '）', 4000);
    else toast(SIDE_MARK[st.winner] + SIDE_NAME[st.winner] + 'の勝ち（' + (REASONS[st.reason] || st.reason) + '）', 4000);
  }

  function resign() {
    const g = app.game;
    if (g.status.over || app.review) return;
    let side;
    if (app.mode === 'online') { side = app.mySide; if (side === null) return; }
    else side = g.turn;
    if (!confirm(SIDE_MARK[side] + SIDE_NAME[side] + 'が投了します。よろしいですか？')) return;
    app.game = S.resign(g, side);
    app.history.push(SIDE_MARK[side] + '投了');
    app.selected = null;
    if (app.net) app.net.send({ t: 'resign', side: side });
    afterChange();
  }

  function startFreshGame(tc) {
    app.game = S.newGame();
    app.history = [];
    app.selected = null;
    app.recordId = null;
    resetClock(tc);
  }

  function newLocalGame() {
    closeReview();
    startFreshGame(selectedTimeControl());
    afterChange();
  }

  // ---------- Records ----------

  function loadRecords() {
    try {
      const arr = JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function storeRecords(arr) {
    try { localStorage.setItem(RECORDS_KEY, JSON.stringify(arr.slice(0, MAX_RECORDS))); }
    catch (e) { toast('棋譜を保存できませんでした（容量不足？）'); }
  }

  function resultText(status) {
    if (!status.over) return '対局中';
    if (status.winner === null) return '引き分け（' + (REASONS[status.reason] || status.reason) + '）';
    return SIDE_MARK[status.winner] + SIDE_NAME[status.winner] + 'の勝ち（' + (REASONS[status.reason] || status.reason) + '）';
  }

  function saveCurrentRecord(silent) {
    const g = app.game;
    if (g.moves.length === 0) return;
    const records = loadRecords();
    let rec = app.recordId ? records.find((r) => r.id === app.recordId) : null;
    if (!rec) {
      rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: new Date().toISOString() };
      records.unshift(rec);
      app.recordId = rec.id;
    }
    rec.updated = new Date().toISOString();
    rec.mode = app.mode === 'online' ? 'online' : 'local';
    rec.mySide = app.mode === 'online' ? app.mySide : null;
    rec.tc = app.clock.tc;
    rec.moves = S.encodeGame(g);
    rec.n = g.moves.filter((t) => t[0] === 'm' || t[0] === 'd').length;
    rec.status = g.status;
    storeRecords(records);
    renderRecords();
    if (!silent) toast('棋譜を保存しました');
  }

  function autoSaveRecord() {
    if (app.game.moves.length === 0) return;
    saveCurrentRecord(true);
  }

  function deleteRecord(id) {
    const records = loadRecords().filter((r) => r.id !== id);
    storeRecords(records);
    if (app.recordId === id) app.recordId = null;
    renderRecords();
  }

  function recordTitle(rec) {
    return formatDate(rec.date) + ' ' + (rec.mode === 'online' ? 'オンライン' : 'ローカル') + ' ' + rec.n + '手';
  }

  function recordText(rec) {
    const r = replay(rec.moves);
    const lines = [
      '将棋 vs チェス',
      '日時: ' + formatDate(rec.date),
      '持ち時間: ' + tcText(rec.tc),
      '結果: ' + resultText(r.state.status),
      '',
    ];
    r.texts.forEach((t, i) => lines.push((i + 1) + ' ' + t));
    return lines.join('\n');
  }

  function renderRecords() {
    const ul = $('records');
    ul.innerHTML = '';
    const records = loadRecords();
    if (!records.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'まだありません';
      ul.appendChild(li);
      return;
    }
    for (const rec of records) {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'rec-info';
      const title = document.createElement('div');
      title.className = 'rec-title';
      title.textContent = recordTitle(rec);
      const sub = document.createElement('div');
      sub.className = 'rec-sub';
      sub.textContent = resultText(rec.status || { over: false }) + ' ・ ' + tcText(rec.tc);
      info.appendChild(title);
      info.appendChild(sub);
      li.appendChild(info);
      const view = document.createElement('button');
      view.className = 'small';
      view.textContent = '再生';
      view.addEventListener('click', () => openReview(rec));
      li.appendChild(view);
      const del = document.createElement('button');
      del.className = 'small danger';
      del.textContent = '削除';
      del.addEventListener('click', () => { if (confirm('この棋譜を削除しますか？')) deleteRecord(rec.id); });
      li.appendChild(del);
      ul.appendChild(li);
    }
  }

  // ---------- Review (replay viewer) ----------

  function openReview(rec) {
    let r;
    try { r = replay(rec.moves); } catch (e) { toast('この棋譜を読み込めませんでした'); return; }
    app.review = { states: r.states, texts: r.texts, index: r.states.length - 1, title: recordTitle(rec), rec: rec };
    app.selected = null;
    render();
  }

  function reviewGo(index) {
    if (!app.review) return;
    app.review.index = Math.max(0, Math.min(app.review.states.length - 1, index));
    render();
  }

  function closeReview() {
    if (!app.review) return;
    app.review = null;
    render();
  }

  // ---------- Online ----------

  function setConnStatus(text, cls) {
    const el = $('conn-status');
    el.textContent = text;
    el.className = 'conn-status ' + (cls || '');
  }

  function inviteUrl(roomId) {
    return location.origin + location.pathname + '?room=' + encodeURIComponent(roomId);
  }

  function appendChat(who, text) {
    const log = $('chat-log');
    const d = document.createElement('div');
    d.className = 'chat-line';
    d.innerHTML = '<b></b> <span></span>';
    d.querySelector('b').textContent = who;
    d.querySelector('span').textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function netHandlers() {
    return {
      ready: function (roomId) {
        $('room-code').textContent = roomId;
        $('invite-url').value = inviteUrl(roomId);
        if (app.role === 'host') setConnStatus('友達の参加を待っています。招待URLを送ってください。', 'waiting');
      },
      status: function (s) {
        if (s === 'connecting') setConnStatus('部屋に接続中…', 'waiting');
        if (s === 'retrying') setConnStatus('相手が見つかりません。再接続します…（相手がまだ部屋を開いていないかもしれません）', 'waiting');
      },
      connected: function () {
        app.peerConnected = true;
        setConnStatus('接続しました', 'ok');
        if (app.role === 'host') sendState();
        render();
      },
      disconnected: function () {
        app.peerConnected = false;
        setConnStatus('相手との接続が切れました。再接続を待っています…', 'bad');
        render();
      },
      busy: function () {
        setConnStatus('この部屋はすでに2人で対局中です。', 'bad');
        toast('部屋が満員です');
      },
      error: function (err) {
        const type = err && err.type;
        if (type === 'unavailable-id') {
          // The room is already hosted (e.g. by another tab of ours): join it as the guest instead.
          toast('この部屋はすでに開かれているので、参加者として入ります');
          setTimeout(() => enterOnline('guest', app.roomId), 0);
        } else if (type === 'peer-unavailable') {
          // handled by retry
        } else {
          setConnStatus('通信エラー: ' + (type || err), 'bad');
        }
      },
      message: onNetMessage,
    };
  }

  function sendState() {
    if (!app.net) return;
    app.net.send({ t: 'state', game: S.encodeGame(app.game), yourSide: 1 - app.hostSide, clock: clockSnapshot() });
  }

  function onNetMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'state': {
        if (app.role !== 'guest') return;
        try {
          loadEncoded(msg.game);
        } catch (e) {
          setConnStatus('局面の同期に失敗しました', 'bad');
          return;
        }
        app.mySide = msg.yourSide === 1 ? 1 : 0;
        app.flipped = app.mySide === S.GOTE;
        app.recordId = null;
        restoreClock(msg.clock);
        if (app.game.status.over) autoSaveRecord();
        render();
        if (app.game.status.over) announceResult();
        break;
      }
      case 'move': {
        try {
          const m = S.findLegal(app.game, msg.code);
          if (!m) throw new Error('illegal');
          if (app.game.turn === app.mySide) throw new Error('not their turn');
          playMove(m, true, msg.times);
        } catch (e) {
          if (app.role === 'host') sendState();
          else app.net.send({ t: 'sync' });
        }
        break;
      }
      case 'sync':
        if (app.role === 'host') sendState();
        break;
      case 'resign': {
        const side = msg.side === 1 ? 1 : 0;
        if (app.game.status.over || side === app.mySide) return;
        app.game = S.resign(app.game, side);
        app.history.push(SIDE_MARK[side] + '投了');
        afterChange();
        break;
      }
      case 'flag': {
        const side = msg.side === 1 ? 1 : 0;
        if (app.game.status.over) return;
        if (Array.isArray(msg.times)) app.clock.times = [Number(msg.times[0]) || 0, Number(msg.times[1]) || 0];
        app.clock.running = null;
        app.game = S.timeout(app.game, side);
        app.history.push(SIDE_MARK[side] + '時間切れ');
        afterChange();
        break;
      }
      case 'rematch':
        if (app.role === 'host') startRematch(true);
        else toast('相手が再戦を希望しています');
        break;
      case 'chat':
        appendChat('相手', String(msg.text || '').slice(0, 200));
        break;
      default:
        break;
    }
  }

  function startRematch(requestedByGuest) {
    if (app.role === 'host') {
      closeReview();
      app.hostSide = 1 - app.hostSide;
      app.mySide = app.hostSide;
      app.flipped = app.mySide === S.GOTE;
      startFreshGame(app.clock.tc);
      sendState();
      afterChange();
      toast(requestedByGuest ? '相手の希望で再戦します（先後交代）' : '再戦します（先後交代）');
    } else {
      app.net.send({ t: 'rematch' });
      toast('再戦を申し込みました');
    }
  }

  function enterOnline(role, roomId, side, tc) {
    if (!SvcNet.available()) { toast('通信ライブラリを読み込めませんでした。ネット接続を確認してください。', 4000); return; }
    if (app.net) app.net.close();
    closeReview();
    app.mode = 'online';
    app.role = role;
    app.roomId = roomId;
    app.peerConnected = false;
    app.selected = null;
    $('chat-log').innerHTML = '';
    if (role === 'host') {
      app.hostSide = side;
      app.mySide = side;
      app.flipped = side === S.GOTE;
      if (tc !== undefined) resetClock(tc);
      saveHostState();
    } else {
      app.mySide = null;
      startFreshGame(null);
    }
    history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(roomId));
    app.net = new SvcNet.Connection(netHandlers());
    setConnStatus('準備中…', 'waiting');
    if (role === 'host') app.net.host(roomId); else app.net.join(roomId);
    render();
  }

  function leaveOnline() {
    if (app.net) app.net.close();
    app.net = null;
    app.mode = 'local';
    app.role = null;
    app.roomId = null;
    app.mySide = null;
    app.peerConnected = false;
    app.selected = null;
    app.clock.running = null;
    history.replaceState(null, '', location.pathname);
    updateHash();
    render();
  }

  // ---------- Wiring ----------

  function init() {
    const onTcChange = () => {
      $('tc-custom').classList.toggle('hidden', $('tc-select').value !== 'custom');
      // Before the first move of a local game the new setting applies immediately.
      if (app.mode === 'local' && app.game.moves.length === 0 && !app.review) { resetClock(selectedTimeControl()); render(); }
    };
    $('tc-select').addEventListener('change', onTcChange);
    $('tc-base').addEventListener('change', onTcChange);
    $('tc-inc').addEventListener('change', onTcChange);
    $('btn-local').addEventListener('click', () => { if (app.mode === 'online') leaveOnline(); newLocalGame(); toast('この端末で交互に指してください'); });
    $('btn-host').addEventListener('click', () => {
      const side = Number($('host-side').value);
      startFreshGame(selectedTimeControl());
      enterOnline('host', SvcNet.newRoomId(), side, app.clock.tc);
    });
    $('btn-join').addEventListener('click', () => {
      const id = SvcNet.normalizeRoomId($('join-code').value);
      if (!id || id.length < 6) { toast('部屋コードを入力してください'); return; }
      enterOnline('guest', id);
    });
    $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
    $('btn-copy-invite').addEventListener('click', () => copyText($('invite-url').value));
    $('btn-leave').addEventListener('click', () => { if (confirm('部屋を出ますか？')) leaveOnline(); });
    $('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('chat-input');
      const text = input.value.trim();
      if (!text) return;
      if (app.net && app.net.send({ t: 'chat', text: text })) { appendChat('自分', text); input.value = ''; }
      else toast('まだ接続していません');
    });
    $('btn-resign').addEventListener('click', resign);
    $('btn-rematch').addEventListener('click', () => {
      if (app.mode === 'online') startRematch(false);
      else if (app.game.moves.length === 0 || app.game.status.over || confirm('対局中です。新しい対局を始めますか？')) newLocalGame();
    });
    $('btn-flip').addEventListener('click', () => { app.flipped = !app.flipped; render(); });
    $('btn-copy-game').addEventListener('click', () => {
      const g = app.review ? app.review.states[app.review.states.length - 1] : app.game;
      const enc = S.encodeGame(g);
      copyText(location.origin + location.pathname + (enc ? '#g=' + enc : ''));
    });
    $('btn-save-record').addEventListener('click', () => saveCurrentRecord(false));
    $('btn-copy-text').addEventListener('click', () => {
      if (app.review) { copyText(recordText(app.review.rec)); return; }
      if (app.game.moves.length === 0) { toast('まだ指していません'); return; }
      copyText(recordText({ date: new Date().toISOString(), tc: app.clock.tc, moves: S.encodeGame(app.game) }));
    });
    $('rv-first').addEventListener('click', () => reviewGo(0));
    $('rv-prev').addEventListener('click', () => reviewGo(app.review.index - 1));
    $('rv-next').addEventListener('click', () => reviewGo(app.review.index + 1));
    $('rv-last').addEventListener('click', () => reviewGo(Infinity));
    $('rv-close').addEventListener('click', closeReview);
    document.addEventListener('keydown', (e) => {
      if (!app.review || e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') reviewGo(app.review.index - 1);
      else if (e.key === 'ArrowRight') reviewGo(app.review.index + 1);
      else if (e.key === 'Home') reviewGo(0);
      else if (e.key === 'End') reviewGo(Infinity);
      else if (e.key === 'Escape') closeReview();
    });
    $('btn-rules').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
    $('btn-rules-close').addEventListener('click', () => $('rules-overlay').classList.add('hidden'));
    $('rules-overlay').addEventListener('click', (e) => { if (e.target === $('rules-overlay')) $('rules-overlay').classList.add('hidden'); });

    renderRecords();

    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      const roomId = SvcNet.normalizeRoomId(room);
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(hostStorageKey(roomId))); } catch (e) { /* ignore */ }
      if (saved && typeof saved.game === 'string') {
        try { loadEncoded(saved.game); } catch (e) { app.game = S.newGame(); app.history = []; }
        app.recordId = saved.recordId || null;
        restoreClock(saved.clock);
        enterOnline('host', roomId, saved.side === 1 ? 1 : 0);
        toast('部屋を再開しました');
      } else {
        enterOnline('guest', roomId);
      }
      return;
    }
    const hash = location.hash.replace(/^#/, '');
    if (hash.indexOf('g=') === 0) {
      try { loadEncoded(hash.slice(2)); toast('棋譜URLから局面を読み込みました'); }
      catch (e) { toast('棋譜URLを読み込めませんでした'); }
      resetClock(null);
    } else {
      resetClock(selectedTimeControl());
    }
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
