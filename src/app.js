/*
 * UI and game-flow controller for Shogi vs Chess.
 * Depends on ShogiChess (src/rules.js) and SvcNet (src/net.js).
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
  };
  const SIDE_NAME = ['将棋（先手）', 'チェス（後手）'];
  const SIDE_MARK = ['☗', '☖'];

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
    if (g.status.over || g.turn !== owner) return false;
    if (app.mode === 'local') return true;
    return app.mySide === owner && app.peerConnected;
  }

  function rebuildHistory(encoded) {
    let st = S.newGame();
    const texts = [];
    for (const tok of (encoded || '').split(',')) {
      if (!tok) continue;
      if (tok[0] === 'R') {
        texts.push(SIDE_MARK[Number(tok[1])] + '投了');
        st = S.resign(st, Number(tok[1]));
      } else {
        const m = S.findLegal(st, tok);
        if (!m) throw new Error('bad move in record: ' + tok);
        texts.push(S.moveToText(st, m));
        st = S.applyMove(st, m);
      }
    }
    return { state: st, texts: texts };
  }

  function loadEncoded(encoded) {
    const r = rebuildHistory(encoded);
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
      localStorage.setItem(hostStorageKey(app.roomId), JSON.stringify({ side: app.hostSide, game: S.encodeGame(app.game) }));
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

  // ---------- Rendering ----------

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
    if (!app.selected) return [];
    if (app.selected.kind === 'sq') return S.legalMovesFrom(g, app.selected.r, app.selected.c);
    return S.legalDrops(g, app.selected.piece);
  }

  function render() {
    renderBoard();
    renderHands();
    renderStatus();
    renderMoves();
    renderButtons();
  }

  function renderBoard() {
    const g = app.game;
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
    el.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'hand-label';
    label.textContent = SIDE_MARK[owner] + ' ' + SIDE_NAME[owner] + ' の持ち駒';
    if (app.mode === 'online' && app.mySide === owner) label.textContent += '（あなた）';
    el.appendChild(label);
    const chips = document.createElement('div');
    chips.className = 'chips';
    const hand = app.game.hands[owner];
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
    sub.textContent = g.inCheck ? '王手！' : (g.moves.length + '手目');
    if (g.inCheck) card.classList.add('check');
  }

  function renderMoves() {
    const ol = $('moves');
    ol.innerHTML = '';
    app.history.forEach((text, i) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (i === app.history.length - 1) li.classList.add('current');
      ol.appendChild(li);
    });
    ol.scrollTop = ol.scrollHeight;
  }

  function renderButtons() {
    const g = app.game;
    const online = app.mode === 'online';
    $('mode-card').classList.toggle('hidden', online);
    $('online-card').classList.toggle('hidden', !online);
    $('btn-resign').disabled = g.status.over || (online && (!app.peerConnected || app.mySide === null));
    $('btn-rematch').disabled = online && !app.peerConnected;
    $('btn-rematch').textContent = online ? '再戦（先後交代）' : '新しい対局';
  }

  // ---------- Interaction ----------

  function onSquareClick(r, c) {
    const g = app.game;
    if (app.pendingPromo) return;
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

  function playMove(move, fromNetwork) {
    const g = app.game;
    const text = S.moveToText(g, move);
    app.game = S.applyMove(g, move);
    app.history.push(text);
    app.selected = null;
    if (!fromNetwork && app.net) app.net.send({ t: 'move', code: S.encodeMove(move) });
    afterChange();
  }

  function afterChange() {
    updateHash();
    saveHostState();
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
    if (g.status.over) return;
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

  function newLocalGame() {
    app.game = S.newGame();
    app.history = [];
    app.selected = null;
    afterChange();
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
    app.net.send({ t: 'state', game: S.encodeGame(app.game), yourSide: 1 - app.hostSide });
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
        render();
        if (app.game.status.over) announceResult();
        break;
      }
      case 'move': {
        try {
          const m = S.findLegal(app.game, msg.code);
          if (!m) throw new Error('illegal');
          if (app.game.turn === app.mySide) throw new Error('not their turn');
          playMove(m, true);
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
      app.hostSide = 1 - app.hostSide;
      app.mySide = app.hostSide;
      app.flipped = app.mySide === S.GOTE;
      app.game = S.newGame();
      app.history = [];
      app.selected = null;
      sendState();
      afterChange();
      toast(requestedByGuest ? '相手の希望で再戦します（先後交代）' : '再戦します（先後交代）');
    } else {
      app.net.send({ t: 'rematch' });
      toast('再戦を申し込みました');
    }
  }

  function enterOnline(role, roomId, side) {
    if (!SvcNet.available()) { toast('通信ライブラリを読み込めませんでした。ネット接続を確認してください。', 4000); return; }
    if (app.net) app.net.close();
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
      saveHostState();
    } else {
      app.mySide = null;
      app.game = S.newGame();
      app.history = [];
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
    history.replaceState(null, '', location.pathname);
    updateHash();
    render();
  }

  // ---------- Wiring ----------

  function init() {
    $('btn-local').addEventListener('click', () => { if (app.mode === 'online') leaveOnline(); newLocalGame(); toast('この端末で交互に指してください'); });
    $('btn-host').addEventListener('click', () => {
      const side = Number($('host-side').value);
      app.game = S.newGame();
      app.history = [];
      enterOnline('host', SvcNet.newRoomId(), side);
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
      const enc = S.encodeGame(app.game);
      copyText(location.origin + location.pathname + (enc ? '#g=' + enc : ''));
    });
    $('btn-rules').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
    $('btn-rules-close').addEventListener('click', () => $('rules-overlay').classList.add('hidden'));
    $('rules-overlay').addEventListener('click', (e) => { if (e.target === $('rules-overlay')) $('rules-overlay').classList.add('hidden'); });

    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      const roomId = SvcNet.normalizeRoomId(room);
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(hostStorageKey(roomId))); } catch (e) { /* ignore */ }
      if (saved && typeof saved.game === 'string') {
        try { loadEncoded(saved.game); } catch (e) { app.game = S.newGame(); app.history = []; }
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
    }
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
