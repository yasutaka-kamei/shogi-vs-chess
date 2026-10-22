/*
 * Shogi vs Chess rules engine.
 *
 * Rule set follows "将棋対チェス" on Shogitter (shogitter.com):
 *   - 9x9 board. Sente (moves first) plays shogi, Gote plays chess.
 *   - Chess side leaves file 1 empty: R N B Q K B N R on files 9..2, pawns in front.
 *   - Both sides may drop captured pieces (shogi style). Captured pieces revert
 *     to their unpromoted form (a promoted chess pawn goes back to a pawn).
 *   - Shogi drop restrictions apply (nifu, no-move squares, uchifuzume), except
 *     that chess pawns may share a file.
 *   - Shogi pieces promote in the far three ranks. A chess pawn promotes on the
 *     last rank to Q/R/B/N.
 *   - Castling and en passant are allowed for the chess side.
 *   - A player with no legal move loses (shogi convention: stalemate = loss).
 *   - Fourfold repetition is a draw (sennichite).
 *
 * Coordinates: board[row][col], row 0 is the top (Gote's back rank, shogi rank
 * 一), col 0 is the left (shogi file 9). Sente's forward direction is -1.
 *
 * This file is a plain script (no ES module syntax) so that it runs both in the
 * browser via <script> and in JavaScriptCore's `jsc` for tests. It exposes
 * `ShogiChess` on the global object.
 */
(function (global) {
  'use strict';

  const N = 9;
  const SENTE = 0; // shogi side, bottom, moves first
  const GOTE = 1;  // chess side, top

  const SHOGI_TYPES = ['FU', 'KY', 'KE', 'GI', 'KI', 'KA', 'HI', 'OU'];
  const CHESS_TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
  const PROMOTABLE_SHOGI = ['FU', 'KY', 'KE', 'GI', 'KA', 'HI'];
  const PAWN_PROMOTIONS = ['q', 'r', 'b', 'n'];
  const HAND_ORDER = ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU', 'q', 'r', 'b', 'n', 'p'];

  const NAMES = {
    FU: '歩', KY: '香', KE: '桂', GI: '銀', KI: '金', KA: '角', HI: '飛', OU: '王',
    p: 'ポーン', n: 'ナイト', b: 'ビショップ', r: 'ルーク', q: 'クイーン', k: 'キング',
  };
  const PROMOTED_NAMES = { FU: 'と', KY: '成香', KE: '成桂', GI: '成銀', KA: '馬', HI: '龍' };
  const CHESS_GLYPHS = {
    // [white, black]
    p: ['♙', '♟'], n: ['♘', '♞'], b: ['♗', '♝'], r: ['♖', '♜'], q: ['♕', '♛'], k: ['♔', '♚'],
  };
  const RANK_KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const FILE_ZENKAKU = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];

  const fwd = (o) => (o === SENTE ? -1 : 1);
  const inBoard = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
  const isShogi = (t) => SHOGI_TYPES.indexOf(t) >= 0;
  const isRoyal = (p) => p.t === 'OU' || p.t === 'k';
  const lastRow = (o) => (o === SENTE ? 0 : N - 1);
  const inZone = (o, r) => (o === SENTE ? r <= 2 : r >= N - 3);

  function mk(t, o, extra) {
    // t: type, o: owner, pr: promoted (shogi), b: base type (chess pawn promotion),
    // mv: has moved, dp: was dropped
    return Object.assign({ t: t, o: o, pr: false, b: null, mv: false, dp: false }, extra || {});
  }

  function emptyBoard() {
    const b = [];
    for (let r = 0; r < N; r++) b.push(new Array(N).fill(null));
    return b;
  }

  function cloneBoard(board) {
    return board.map((row) => row.map((p) => (p ? Object.assign({}, p) : null)));
  }

  function cloneHands(hands) {
    return [Object.assign({}, hands[0]), Object.assign({}, hands[1])];
  }

  function newGame() {
    const board = emptyBoard();
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (let c = 0; c < 8; c++) {
      board[0][c] = mk(back[c], GOTE);
      board[1][c] = mk('p', GOTE);
    }
    const sback = ['KY', 'KE', 'GI', 'KI', 'OU', 'KI', 'GI', 'KE', 'KY'];
    for (let c = 0; c < N; c++) {
      board[8][c] = mk(sback[c], SENTE);
      board[6][c] = mk('FU', SENTE);
    }
    board[7][1] = mk('KA', SENTE); // 8八
    board[7][7] = mk('HI', SENTE); // 2八
    const state = {
      board: board,
      hands: [{}, {}],
      turn: SENTE,
      ep: null, // square passed over by a double-stepping pawn: {r, c}
      moves: [], // encoded move strings
      positions: {},
      status: { over: false, winner: null, reason: null },
      inCheck: false,
      lastMove: null,
    };
    state.positions[positionKey(state)] = 1;
    return state;
  }

  function positionKey(state) {
    let s = '';
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = state.board[r][c];
        s += p ? p.t + p.o + (p.pr ? '+' : '') + (p.b ? '/' + p.b : '') : '.';
        s += ',';
      }
    }
    s += '|' + handString(state.hands[0]) + '|' + handString(state.hands[1]) + '|' + state.turn;
    return s;
  }

  function handString(hand) {
    return HAND_ORDER.filter((t) => hand[t]).map((t) => t + hand[t]).join('');
  }

  // ---------- Piece movement definitions ----------

  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ALL8 = ORTH.concat(DIAG);
  const KNIGHT = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];

  function stepsFor(p) {
    const f = fwd(p.o);
    const KIN = [[f, 0], [f, 1], [f, -1], [0, 1], [0, -1], [-f, 0]];
    switch (p.t) {
      case 'FU': return p.pr ? KIN : [[f, 0]];
      case 'KY': return p.pr ? KIN : [];
      case 'KE': return p.pr ? KIN : [[2 * f, 1], [2 * f, -1]];
      case 'GI': return p.pr ? KIN : [[f, 0], [f, 1], [f, -1], [-f, 1], [-f, -1]];
      case 'KI': return KIN;
      case 'KA': return p.pr ? ORTH : [];
      case 'HI': return p.pr ? DIAG : [];
      case 'OU': case 'k': return ALL8;
      case 'n': return KNIGHT;
      default: return [];
    }
  }

  function slidesFor(p) {
    const f = fwd(p.o);
    switch (p.t) {
      case 'KY': return p.pr ? [] : [[f, 0]];
      case 'KA': case 'b': return DIAG;
      case 'HI': case 'r': return ORTH;
      case 'q': return ALL8;
      default: return [];
    }
  }

  // Squares attacked by the piece at (r, c), ignoring king safety. Used for
  // check detection. Pawns only attack diagonally.
  function attackSquares(board, r, c) {
    const p = board[r][c];
    const out = [];
    if (p.t === 'p') {
      const f = fwd(p.o);
      for (const dc of [1, -1]) if (inBoard(r + f, c + dc)) out.push([r + f, c + dc]);
      return out;
    }
    for (const d of stepsFor(p)) {
      const rr = r + d[0], cc = c + d[1];
      if (inBoard(rr, cc)) out.push([rr, cc]);
    }
    for (const d of slidesFor(p)) {
      let rr = r + d[0], cc = c + d[1];
      while (inBoard(rr, cc)) {
        out.push([rr, cc]);
        if (board[rr][cc]) break;
        rr += d[0]; cc += d[1];
      }
    }
    return out;
  }

  function isAttacked(board, r, c, byOwner) {
    for (let rr = 0; rr < N; rr++) {
      for (let cc = 0; cc < N; cc++) {
        const p = board[rr][cc];
        if (!p || p.o !== byOwner) continue;
        for (const sq of attackSquares(board, rr, cc)) {
          if (sq[0] === r && sq[1] === c) return true;
        }
      }
    }
    return false;
  }

  function findKing(board, owner) {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = board[r][c];
        if (p && p.o === owner && isRoyal(p)) return [r, c];
      }
    }
    return null;
  }

  function kingInCheck(board, owner) {
    const k = findKing(board, owner);
    if (!k) return false;
    return isAttacked(board, k[0], k[1], 1 - owner);
  }

  // ---------- Pseudo-legal move generation ----------

  // Board moves (without promotion variants) for the piece at (r, c).
  function pseudoBoardMoves(state, r, c) {
    const board = state.board;
    const p = board[r][c];
    const out = [];
    const push = (tr, tc, extra) => out.push(Object.assign({ kind: 'move', from: [r, c], to: [tr, tc] }, extra || {}));

    if (p.t === 'p') {
      const f = fwd(p.o);
      if (inBoard(r + f, c) && !board[r + f][c]) {
        push(r + f, c);
        if (!p.mv && !p.dp && inBoard(r + 2 * f, c) && !board[r + 2 * f][c]) push(r + 2 * f, c, { double: true });
      }
      for (const dc of [1, -1]) {
        const tr = r + f, tc = c + dc;
        if (!inBoard(tr, tc)) continue;
        const q = board[tr][tc];
        if (q && q.o !== p.o) push(tr, tc);
        else if (!q && state.ep && state.ep.r === tr && state.ep.c === tc) push(tr, tc, { ep: true });
      }
      return out;
    }

    for (const d of stepsFor(p)) {
      const tr = r + d[0], tc = c + d[1];
      if (!inBoard(tr, tc)) continue;
      const q = board[tr][tc];
      if (!q || q.o !== p.o) push(tr, tc);
    }
    for (const d of slidesFor(p)) {
      let tr = r + d[0], tc = c + d[1];
      while (inBoard(tr, tc)) {
        const q = board[tr][tc];
        if (!q) push(tr, tc);
        else { if (q.o !== p.o) push(tr, tc); break; }
        tr += d[0]; tc += d[1];
      }
    }

    if (p.t === 'k' && !p.mv && !p.dp) {
      for (const d of [1, -1]) {
        let cc = c + d;
        while (inBoard(r, cc) && !board[r][cc]) cc += d;
        if (!inBoard(r, cc)) continue;
        const rook = board[r][cc];
        if (rook.t !== 'r' || rook.o !== p.o || rook.mv || rook.dp) continue;
        if (Math.abs(cc - c) < 3) continue;
        const opp = 1 - p.o;
        if (isAttacked(board, r, c, opp) || isAttacked(board, r, c + d, opp) || isAttacked(board, r, c + 2 * d, opp)) continue;
        push(r, c + 2 * d, { castle: true, rookFrom: [r, cc], rookTo: [r, c + d] });
      }
    }
    return out;
  }

  // Expand a base move into promotion variants.
  function promotionVariants(p, m) {
    const o = p.o;
    const tr = m.to[0];
    if (p.t === 'p') {
      if (tr === lastRow(o)) return PAWN_PROMOTIONS.map((t) => Object.assign({}, m, { promote: t }));
      return [m];
    }
    if (isShogi(p.t) && !p.pr && PROMOTABLE_SHOGI.indexOf(p.t) >= 0) {
      if (inZone(o, m.from[0]) || inZone(o, tr)) {
        const must = !hasFutureMoves(p.t, o, tr);
        const variants = [Object.assign({}, m, { promote: true })];
        if (!must) variants.push(Object.assign({}, m, { promote: false }));
        return variants;
      }
    }
    return [m];
  }

  // Would an unpromoted piece of this type ever be able to move from row r?
  function hasFutureMoves(t, o, r) {
    const last = lastRow(o);
    if (t === 'FU' || t === 'KY' || t === 'p') return r !== last;
    if (t === 'KE') return Math.abs(r - last) >= 2;
    return true;
  }

  function dropSquares(state, t, owner) {
    const board = state.board;
    const out = [];
    const fileHasPawn = [];
    if (t === 'FU') {
      for (let c = 0; c < N; c++) {
        fileHasPawn[c] = false;
        for (let r = 0; r < N; r++) {
          const p = board[r][c];
          if (p && p.o === owner && p.t === 'FU' && !p.pr) { fileHasPawn[c] = true; break; }
        }
      }
    }
    for (let r = 0; r < N; r++) {
      if (!hasFutureMoves(t, owner, r)) continue;
      for (let c = 0; c < N; c++) {
        if (board[r][c]) continue;
        if (t === 'FU' && fileHasPawn[c]) continue;
        out.push({ kind: 'drop', piece: t, to: [r, c] });
      }
    }
    return out;
  }

  // ---------- Applying moves (board-level) ----------

  // Apply a move to board/hands in place. Returns info about the capture.
  function execute(board, hands, ep, move, owner) {
    let captured = null;
    let newEp = null;
    if (move.kind === 'drop') {
      hands[owner][move.piece] -= 1;
      if (hands[owner][move.piece] === 0) delete hands[owner][move.piece];
      board[move.to[0]][move.to[1]] = mk(move.piece, owner, { mv: true, dp: true });
      return { captured: null, ep: null };
    }
    const p = board[move.from[0]][move.from[1]];
    const target = board[move.to[0]][move.to[1]];
    if (target) captured = target;
    if (move.ep) {
      const f = fwd(owner);
      const cr = move.to[0] - f, cc = move.to[1];
      captured = board[cr][cc];
      board[cr][cc] = null;
    }
    board[move.from[0]][move.from[1]] = null;
    const np = Object.assign({}, p, { mv: true });
    if (move.promote === true) np.pr = true;
    else if (typeof move.promote === 'string') { np.b = p.t; np.t = move.promote; }
    board[move.to[0]][move.to[1]] = np;
    if (move.castle) {
      const rook = board[move.rookFrom[0]][move.rookFrom[1]];
      board[move.rookFrom[0]][move.rookFrom[1]] = null;
      board[move.rookTo[0]][move.rookTo[1]] = Object.assign({}, rook, { mv: true });
    }
    if (move.double) newEp = { r: (move.from[0] + move.to[0]) / 2, c: move.to[1] };
    if (captured) {
      const base = captured.b || captured.t;
      hands[owner][base] = (hands[owner][base] || 0) + 1;
    }
    return { captured: captured, ep: newEp };
  }

  function leavesKingInCheck(state, move, owner) {
    const board = cloneBoard(state.board);
    const hands = cloneHands(state.hands);
    execute(board, hands, state.ep, move, owner);
    return kingInCheck(board, owner);
  }

  // ---------- Legal move generation ----------

  function generateLegal(state, owner, checkUchifuzume) {
    const board = state.board;
    const out = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = board[r][c];
        if (!p || p.o !== owner) continue;
        for (const base of pseudoBoardMoves(state, r, c)) {
          if (leavesKingInCheck(state, base, owner)) continue;
          for (const m of promotionVariants(p, base)) out.push(m);
        }
      }
    }
    const hand = state.hands[owner];
    for (const t of HAND_ORDER) {
      if (!hand[t]) continue;
      for (const m of dropSquares(state, t, owner)) {
        if (leavesKingInCheck(state, m, owner)) continue;
        if (checkUchifuzume && (t === 'FU' || t === 'p') && isUchifuzume(state, m, owner)) continue;
        out.push(m);
      }
    }
    return out;
  }

  // A pawn drop that delivers checkmate is illegal.
  function isUchifuzume(state, move, owner) {
    const board = cloneBoard(state.board);
    const hands = cloneHands(state.hands);
    execute(board, hands, state.ep, move, owner);
    const opp = 1 - owner;
    if (!kingInCheck(board, opp)) return false;
    const next = { board: board, hands: hands, ep: null, turn: opp };
    return generateLegal(next, opp, false).length === 0;
  }

  function legalMoves(state) {
    if (state._legal) return state._legal;
    const moves = state.status.over ? [] : generateLegal(state, state.turn, true);
    Object.defineProperty(state, '_legal', { value: moves, enumerable: false, configurable: true, writable: true });
    return moves;
  }

  function legalMovesFrom(state, r, c) {
    return legalMoves(state).filter((m) => m.kind === 'move' && m.from[0] === r && m.from[1] === c);
  }

  function legalDrops(state, piece) {
    return legalMoves(state).filter((m) => m.kind === 'drop' && m.piece === piece);
  }

  // ---------- Move encoding ----------

  function encodeMove(m) {
    if (m.kind === 'drop') return 'd' + m.piece + m.to[0] + m.to[1];
    let s = 'm' + m.from[0] + m.from[1] + m.to[0] + m.to[1];
    if (m.promote === true) s += '+';
    else if (m.promote === false) s += '=';
    else if (typeof m.promote === 'string') s += m.promote;
    return s;
  }

  function sameMove(a, b) {
    return encodeMove(a) === encodeMove(b);
  }

  // Find the legal move matching an encoded string (or a partial move object).
  function findLegal(state, spec) {
    const code = typeof spec === 'string' ? spec : encodeMove(spec);
    for (const m of legalMoves(state)) if (encodeMove(m) === code) return m;
    return null;
  }

  // ---------- Applying moves (state-level) ----------

  function applyMove(state, spec) {
    const move = findLegal(state, spec);
    if (!move) throw new Error('Illegal move: ' + (typeof spec === 'string' ? spec : encodeMove(spec)));
    const owner = state.turn;
    const board = cloneBoard(state.board);
    const hands = cloneHands(state.hands);
    const info = execute(board, hands, state.ep, move, owner);
    const next = {
      board: board,
      hands: hands,
      turn: 1 - owner,
      ep: info.ep,
      moves: state.moves.concat([encodeMove(move)]),
      positions: Object.assign({}, state.positions),
      status: { over: false, winner: null, reason: null },
      inCheck: false,
      lastMove: move,
    };
    const key = positionKey(next);
    next.positions[key] = (next.positions[key] || 0) + 1;
    next.inCheck = kingInCheck(board, next.turn);
    if (legalMoves(next).length === 0) {
      next.status = { over: true, winner: owner, reason: next.inCheck ? 'checkmate' : 'stalemate' };
    } else if (next.positions[key] >= 4) {
      next.status = { over: true, winner: null, reason: 'repetition' };
    }
    return next;
  }

  function resign(state, owner) {
    const next = Object.assign({}, state, {
      status: { over: true, winner: 1 - owner, reason: 'resign' },
      moves: state.moves.concat(['R' + owner]),
    });
    delete next._legal;
    return next;
  }

  // ---------- Game serialization (replay of moves) ----------

  function encodeGame(state) {
    return state.moves.join(',');
  }

  function decodeGame(str) {
    let state = newGame();
    if (!str) return state;
    for (const tok of str.split(',')) {
      if (!tok) continue;
      if (tok[0] === 'R') state = resign(state, Number(tok[1]));
      else state = applyMove(state, tok);
    }
    return state;
  }

  // ---------- Display helpers ----------

  function pieceName(p) {
    if (p.pr && PROMOTED_NAMES[p.t]) return PROMOTED_NAMES[p.t];
    return NAMES[p.t] || p.t;
  }

  function squareName(r, c) {
    return FILE_ZENKAKU[N - 1 - c] + RANK_KANJI[r];
  }

  function moveToText(state, move) {
    const mark = state.turn === SENTE ? '☗' : '☖';
    if (move.kind === 'drop') return mark + squareName(move.to[0], move.to[1]) + NAMES[move.piece] + '打';
    const p = state.board[move.from[0]][move.from[1]];
    if (move.castle) return mark + 'キャスリング(' + squareName(move.to[0], move.to[1]) + ')';
    let s = mark + squareName(move.to[0], move.to[1]) + pieceName(p);
    if (move.promote === true) s += '成';
    else if (move.promote === false) s += '不成';
    else if (typeof move.promote === 'string') s += '=' + NAMES[move.promote];
    if (move.ep) s += '(アンパッサン)';
    return s;
  }

  global.ShogiChess = {
    N: N, SENTE: SENTE, GOTE: GOTE,
    SHOGI_TYPES: SHOGI_TYPES, CHESS_TYPES: CHESS_TYPES, HAND_ORDER: HAND_ORDER,
    PAWN_PROMOTIONS: PAWN_PROMOTIONS, NAMES: NAMES, PROMOTED_NAMES: PROMOTED_NAMES,
    CHESS_GLYPHS: CHESS_GLYPHS, RANK_KANJI: RANK_KANJI, FILE_ZENKAKU: FILE_ZENKAKU,
    newGame: newGame, legalMoves: legalMoves, legalMovesFrom: legalMovesFrom, legalDrops: legalDrops,
    applyMove: applyMove, resign: resign, findLegal: findLegal,
    encodeMove: encodeMove, sameMove: sameMove, encodeGame: encodeGame, decodeGame: decodeGame,
    isAttacked: isAttacked, kingInCheck: kingInCheck, findKing: findKing,
    pieceName: pieceName, squareName: squareName, moveToText: moveToText, positionKey: positionKey,
    isShogiType: isShogi, inZone: inZone, mk: mk, emptyBoard: emptyBoard,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
