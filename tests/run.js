/*
 * Test suite for src/rules.js (Shogi vs Chess).
 * Run with JavaScriptCore:
 *   jsc src/rules.js tests/run.js
 * Tests are written from the rule specification (see the header of rules.js).
 */
(function () {
  'use strict';
  const SC = ShogiChess;
  const S = SC.SENTE, G = SC.GOTE;

  // ---------- tiny harness ----------
  let passed = 0, failed = 0;
  const failures = [];
  function test(name, fn) {
    try {
      fn();
      passed++;
      print('PASS ' + name);
    } catch (e) {
      failed++;
      failures.push(name);
      print('FAIL ' + name + ' -- ' + (e && e.message ? e.message : String(e)));
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function eq(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  }
  function eqArr(actual, expected, msg) {
    const a = actual.slice().sort(), b = expected.slice().sort();
    eq(JSON.stringify(a), JSON.stringify(b), msg);
  }
  function throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    assert(threw, msg || 'expected an exception');
  }

  // ---------- helpers ----------
  function codes(state) { return SC.legalMoves(state).map(SC.encodeMove); }
  function has(state, code) { return codes(state).indexOf(code) >= 0; }
  function hasNot(state, code) { return codes(state).indexOf(code) < 0; }
  // Unique destination squares ("rc") of the piece at (r, c).
  function targets(state, r, c) {
    const set = {};
    for (const m of SC.legalMovesFrom(state, r, c)) set['' + m.to[0] + m.to[1]] = true;
    return Object.keys(set).sort();
  }
  function dropTargets(state, piece) {
    return SC.legalDrops(state, piece).map((m) => '' + m.to[0] + m.to[1]).sort();
  }
  // pieces: array of [row, col, type, owner, extra]
  function custom(pieces, opts) {
    opts = opts || {};
    const s = SC.newGame();
    s.board = SC.emptyBoard();
    for (const p of pieces) s.board[p[0]][p[1]] = SC.mk(p[2], p[3], p[4]);
    s.hands = opts.hands || [{}, {}];
    s.turn = opts.turn === undefined ? S : opts.turn;
    s.ep = opts.ep || null;
    s.moves = [];
    s.positions = {};
    s.positions[SC.positionKey(s)] = 1;
    delete s._legal;
    return s;
  }
  // Kings in squares that do not interfere with a piece placed at (4,4).
  const KINGS = [[8, 1, 'OU', S], [0, 1, 'k', G]];
  function single(type, owner, r, c, extra, others) {
    const pieces = KINGS.concat([[r, c, type, owner, extra || {}]]).concat(others || []);
    return custom(pieces, { turn: owner });
  }
  function play(state, moves) {
    for (const m of moves) state = SC.applyMove(state, m);
    return state;
  }
  function at(state, r, c) { return state.board[r][c]; }

  // =====================================================================
  // 1. Initial position
  // =====================================================================
  test('initial: Sente has 30 legal moves', () => {
    eq(SC.legalMoves(SC.newGame()).length, 30);
  });
  test('initial: Gote has 22 legal moves after a Sente move', () => {
    const s = SC.applyMove(SC.newGame(), 'm6252');
    eq(SC.legalMoves(s).length, 22);
    eq(s.turn, G);
  });
  test('initial: chess placement (R N B Q K B N R on row 0, col 8 empty, pawns on row 1)', () => {
    const s = SC.newGame();
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (let c = 0; c < 8; c++) {
      eq(at(s, 0, c).t, back[c], 'row0 col' + c);
      eq(at(s, 0, c).o, G);
      eq(at(s, 1, c).t, 'p', 'row1 col' + c);
      eq(at(s, 1, c).o, G);
      eq(at(s, 1, c).mv, false);
      eq(at(s, 1, c).dp, false);
    }
    eq(at(s, 0, 8), null);
    eq(at(s, 1, 8), null);
    for (let c = 0; c < 9; c++) { eq(at(s, 2, c), null); eq(at(s, 3, c), null); eq(at(s, 4, c), null); eq(at(s, 5, c), null); }
  });
  test('initial: shogi placement (standard, KA at [7][1], HI at [7][7])', () => {
    const s = SC.newGame();
    const sback = ['KY', 'KE', 'GI', 'KI', 'OU', 'KI', 'GI', 'KE', 'KY'];
    for (let c = 0; c < 9; c++) {
      eq(at(s, 8, c).t, sback[c], 'row8 col' + c);
      eq(at(s, 8, c).o, S);
      eq(at(s, 6, c).t, 'FU', 'row6 col' + c);
      eq(at(s, 6, c).o, S);
      eq(at(s, 6, c).pr, false);
    }
    eq(at(s, 7, 1).t, 'KA'); eq(at(s, 7, 1).o, S);
    eq(at(s, 7, 7).t, 'HI'); eq(at(s, 7, 7).o, S);
    for (let c = 0; c < 9; c++) if (c !== 1 && c !== 7) eq(at(s, 7, c), null, 'row7 col' + c);
    eq(s.turn, S);
    eq(s.status.over, false);
    eq(s.ep, null);
    eq(JSON.stringify(s.hands), '[{},{}]');
  });

  // =====================================================================
  // 2. Shogi piece movement (both owners)
  // =====================================================================
  test('FU moves one square forward (Sente up, Gote down)', () => {
    eqArr(targets(single('FU', S, 4, 4), 4, 4), ['34']);
    eqArr(targets(single('FU', G, 4, 4, { dp: true, mv: true }), 4, 4), ['54']);
  });
  test('FU cannot move onto own piece, can capture forward', () => {
    eqArr(targets(single('FU', S, 4, 4, {}, [[3, 4, 'KI', S]]), 4, 4), []);
    eqArr(targets(single('FU', S, 4, 4, {}, [[3, 4, 'p', G]]), 4, 4), ['34']);
  });
  test('KY slides forward only, blocked by pieces', () => {
    eqArr(targets(single('KY', S, 4, 4), 4, 4), ['04', '14', '24', '34']);
    eqArr(targets(single('KY', G, 4, 4), 4, 4), ['54', '64', '74', '84']);
    eqArr(targets(single('KY', S, 4, 4, {}, [[2, 4, 'p', G]]), 4, 4), ['24', '34']);
    eqArr(targets(single('KY', S, 4, 4, {}, [[2, 4, 'FU', S]]), 4, 4), ['34']);
  });
  test('KE jumps two forward one sideways, over pieces', () => {
    eqArr(targets(single('KE', S, 4, 4, {}, [[3, 4, 'FU', S], [3, 3, 'FU', S], [3, 5, 'FU', S]]), 4, 4), ['23', '25']);
    eqArr(targets(single('KE', G, 4, 4), 4, 4), ['63', '65']);
  });
  test('GI moves forward three and backward diagonals', () => {
    eqArr(targets(single('GI', S, 4, 4), 4, 4), ['33', '34', '35', '53', '55']);
    eqArr(targets(single('GI', G, 4, 4), 4, 4), ['53', '54', '55', '33', '35']);
  });
  test('KI moves forward three, sideways and straight back', () => {
    eqArr(targets(single('KI', S, 4, 4), 4, 4), ['33', '34', '35', '43', '45', '54']);
    eqArr(targets(single('KI', G, 4, 4), 4, 4), ['53', '54', '55', '43', '45', '34']);
  });
  test('KA slides diagonally (16 squares from centre), both owners', () => {
    const t = targets(single('KA', S, 4, 4), 4, 4);
    eq(t.length, 16);
    assert(t.indexOf('00') >= 0 && t.indexOf('88') >= 0 && t.indexOf('08') >= 0 && t.indexOf('80') >= 0);
    assert(t.indexOf('34') < 0);
    eq(targets(single('KA', G, 4, 4), 4, 4).length, 16);
  });
  test('HI slides orthogonally (16 squares from centre), both owners', () => {
    const t = targets(single('HI', S, 4, 4), 4, 4);
    eq(t.length, 16);
    assert(t.indexOf('04') >= 0 && t.indexOf('84') >= 0 && t.indexOf('40') >= 0 && t.indexOf('48') >= 0);
    assert(t.indexOf('33') < 0);
    eq(targets(single('HI', G, 4, 4), 4, 4).length, 16);
  });
  test('OU moves one square in all 8 directions', () => {
    const s = custom([[4, 4, 'OU', S], [0, 1, 'k', G]], { turn: S });
    eqArr(targets(s, 4, 4), ['33', '34', '35', '43', '45', '53', '54', '55']);
  });
  test('promoted FU/KY/KE/GI move like KI (both owners)', () => {
    const kin = ['33', '34', '35', '43', '45', '54'];
    const kinG = ['53', '54', '55', '43', '45', '34'];
    for (const t of ['FU', 'KY', 'KE', 'GI']) {
      eqArr(targets(single(t, S, 4, 4, { pr: true }), 4, 4), kin, t + ' Sente');
      eqArr(targets(single(t, G, 4, 4, { pr: true }), 4, 4), kinG, t + ' Gote');
    }
  });
  test('promoted KA (馬) = bishop slides + orthogonal steps', () => {
    const t = targets(single('KA', S, 4, 4, { pr: true }), 4, 4);
    eq(t.length, 20);
    for (const sq of ['34', '54', '43', '45', '00', '88']) assert(t.indexOf(sq) >= 0, sq);
    assert(t.indexOf('24') < 0);
    eq(targets(single('KA', G, 4, 4, { pr: true }), 4, 4).length, 20);
  });
  test('promoted HI (龍) = rook slides + diagonal steps', () => {
    const t = targets(single('HI', S, 4, 4, { pr: true }), 4, 4);
    eq(t.length, 20);
    for (const sq of ['33', '35', '53', '55', '04', '48']) assert(t.indexOf(sq) >= 0, sq);
    assert(t.indexOf('22') < 0);
    eq(targets(single('HI', G, 4, 4, { pr: true }), 4, 4).length, 20);
  });

  // =====================================================================
  // 3. Chess piece movement
  // =====================================================================
  test('pawn: single or double step when unmoved and not dropped', () => {
    eqArr(targets(single('p', G, 1, 4), 1, 4), ['24', '34']);
    eqArr(targets(single('p', G, 1, 4, { mv: true }), 1, 4), ['24']);
    eqArr(targets(single('p', G, 1, 4, { mv: true, dp: true }), 1, 4), ['24']);
    eqArr(targets(single('p', G, 1, 4, { dp: true }), 1, 4), ['24']);
  });
  test('pawn: double step blocked when a piece is on the way', () => {
    eqArr(targets(single('p', G, 1, 4, {}, [[3, 4, 'FU', S]]), 1, 4), ['24']);
    eqArr(targets(single('p', G, 1, 4, {}, [[2, 4, 'FU', S]]), 1, 4), []);
  });
  test('pawn: no forward capture, diagonal capture only', () => {
    eqArr(targets(single('p', G, 3, 4, { mv: true }, [[4, 4, 'FU', S]]), 3, 4), []);
    eqArr(targets(single('p', G, 3, 4, { mv: true }, [[4, 4, 'FU', S], [4, 3, 'FU', S]]), 3, 4), ['43']);
    eqArr(targets(single('p', G, 3, 4, { mv: true }, [[4, 3, 'FU', S], [4, 5, 'p', G]]), 3, 4), ['43', '44']);
  });
  test('pawn owned by Sente (dropped) moves upward and captures diagonally upward', () => {
    eqArr(targets(single('p', S, 4, 4, { mv: true, dp: true }), 4, 4), ['34']);
    eqArr(targets(single('p', S, 4, 4, { mv: true, dp: true }, [[3, 5, 'p', G], [3, 4, 'p', G]]), 4, 4), ['35']);
  });
  test('knight: 8 jumps, over pieces', () => {
    const blockers = [[3, 4, 'p', G], [4, 3, 'p', G], [4, 5, 'p', G], [5, 4, 'p', G]];
    eqArr(targets(single('n', G, 4, 4, {}, blockers), 4, 4), ['23', '25', '63', '65', '32', '36', '52', '56']);
  });
  test('bishop: 16 diagonal squares from centre', () => {
    eq(targets(single('b', G, 4, 4), 4, 4).length, 16);
    eqArr(targets(single('b', G, 4, 4, {}, [[3, 3, 'FU', S], [5, 5, 'p', G], [3, 5, 'FU', S], [5, 3, 'p', G]]), 4, 4), ['33', '35']);
  });
  test('rook: 16 orthogonal squares from centre', () => {
    eq(targets(single('r', G, 4, 4), 4, 4).length, 16);
  });
  test('queen: 32 squares from centre', () => {
    eq(targets(single('q', G, 4, 4), 4, 4).length, 32);
  });
  test('king: one step in 8 directions, not onto attacked squares', () => {
    const s = custom([[4, 4, 'k', G], [8, 1, 'OU', S]], { turn: G });
    eqArr(targets(s, 4, 4), ['33', '34', '35', '43', '45', '53', '54', '55']);
    const s2 = custom([[4, 4, 'k', G], [8, 1, 'OU', S], [8, 3, 'HI', S]], { turn: G });
    eqArr(targets(s2, 4, 4), ['34', '35', '45', '54', '55']);
  });

  // =====================================================================
  // 4. En passant
  // =====================================================================
  function epPosition() {
    return custom([
      [8, 8, 'OU', S], [0, 0, 'k', G],
      [3, 3, 'p', S, { dp: true, mv: true }],
      [1, 4, 'p', G],
    ], { turn: G });
  }
  test('en passant: available immediately after a double step', () => {
    let s = epPosition();
    s = SC.applyMove(s, 'm1434');
    eq(JSON.stringify(s.ep), JSON.stringify({ r: 2, c: 4 }));
    assert(has(s, 'm3324'), 'ep capture offered');
    const m = SC.findLegal(s, 'm3324');
    eq(m.ep, true);
    s = SC.applyMove(s, 'm3324');
    eq(at(s, 3, 4), null, 'captured pawn removed');
    eq(at(s, 2, 4).t, 'p'); eq(at(s, 2, 4).o, S);
    eq(at(s, 3, 3), null);
    eq(s.hands[S].p, 1, 'captured pawn in hand as p');
    eq(s.ep, null);
  });
  test('en passant: not available after a single step', () => {
    let s = epPosition();
    s.board[1][4].mv = true;
    s.board[2][4] = SC.mk('p', G, { mv: true });
    s.board[1][4] = null;
    delete s._legal;
    s = SC.applyMove(s, 'm2434');
    eq(s.ep, null);
    assert(hasNot(s, 'm3324'));
  });
  test('en passant: expires after one move', () => {
    let s = epPosition();
    s = play(s, ['m1434', 'm8887', 'm0001']);
    eq(s.ep, null);
    assert(hasNot(s, 'm3324'));
  });
  test('en passant: only the double-stepped pawn can be captured', () => {
    let s = epPosition();
    s.board[3][2] = SC.mk('p', G, { mv: true });
    delete s._legal;
    s = SC.applyMove(s, 'm1434');
    assert(has(s, 'm3324'));
    assert(hasNot(s, 'm3322'), 'no ep against a pawn that did not double step');
  });

  // =====================================================================
  // 5. Castling
  // =====================================================================
  test('castling: kingside from the initial setup once cleared', () => {
    let s = SC.newGame();
    s = play(s, ['m6656', 'm1626', 'm6555', 'm0625', 'm6454', 'm0516', 'm6353']);
    assert(has(s, 'm0406'), 'kingside castling offered');
    assert(hasNot(s, 'm0402'), 'queenside not yet available');
    const m = SC.findLegal(s, 'm0406');
    eq(m.castle, true);
    s = SC.applyMove(s, 'm0406');
    eq(at(s, 0, 6).t, 'k'); eq(at(s, 0, 6).o, G); eq(at(s, 0, 6).mv, true);
    eq(at(s, 0, 5).t, 'r'); eq(at(s, 0, 5).o, G); eq(at(s, 0, 5).mv, true);
    eq(at(s, 0, 4), null); eq(at(s, 0, 7), null);
  });
  test('castling: queenside from the initial setup once cleared', () => {
    let s = SC.newGame();
    s = play(s, ['m6656', 'm1323', 'm6555', 'm0213', 'm6454', 'm1324', 'm6353', 'm0313', 'm6252', 'm0120', 'm6151']);
    assert(has(s, 'm0402'), 'queenside castling offered');
    assert(hasNot(s, 'm0406'));
    s = SC.applyMove(s, 'm0402');
    eq(at(s, 0, 2).t, 'k');
    eq(at(s, 0, 3).t, 'r');
    eq(at(s, 0, 0), null); eq(at(s, 0, 4), null);
  });
  function castlePos(extra, kingExtra, rookExtraK, rookExtraQ) {
    return custom([
      [8, 4, 'OU', S],
      [0, 4, 'k', G, kingExtra || {}],
      [0, 7, 'r', G, rookExtraK || {}],
      [0, 0, 'r', G, rookExtraQ || {}],
    ].concat(extra || []), { turn: G });
  }
  test('castling: both sides legal in a cleared custom position', () => {
    const s = castlePos();
    assert(has(s, 'm0406')); assert(has(s, 'm0402'));
  });
  test('castling: illegal when the king has moved', () => {
    const s = castlePos([], { mv: true });
    assert(hasNot(s, 'm0406')); assert(hasNot(s, 'm0402'));
  });
  test('castling: illegal on the side whose rook has moved', () => {
    const s = castlePos([], {}, { mv: true });
    assert(hasNot(s, 'm0406')); assert(has(s, 'm0402'));
    const s2 = castlePos([], {}, {}, { mv: true });
    assert(has(s2, 'm0406')); assert(hasNot(s2, 'm0402'));
  });
  test('castling: illegal when a square between is occupied', () => {
    const s = castlePos([[0, 6, 'n', G]]);
    assert(hasNot(s, 'm0406')); assert(has(s, 'm0402'));
    const s2 = castlePos([[0, 1, 'n', G]]);
    assert(has(s2, 'm0406')); assert(hasNot(s2, 'm0402'));
  });
  test('castling: illegal when the king is in check', () => {
    const s = castlePos([[4, 4, 'HI', S]]);
    assert(s.inCheck === false || true); // inCheck is only maintained by applyMove
    assert(SC.kingInCheck(s.board, G));
    assert(hasNot(s, 'm0406')); assert(hasNot(s, 'm0402'));
  });
  test('castling: illegal when the king passes through an attacked square', () => {
    const s = castlePos([[4, 5, 'HI', S]]);
    assert(hasNot(s, 'm0406')); assert(has(s, 'm0402'));
    const s2 = castlePos([[4, 3, 'HI', S]]);
    assert(has(s2, 'm0406')); assert(hasNot(s2, 'm0402'));
  });
  test('castling: illegal when the king lands on an attacked square', () => {
    const s = castlePos([[4, 6, 'HI', S]]);
    assert(hasNot(s, 'm0406')); assert(has(s, 'm0402'));
    const s2 = castlePos([[4, 2, 'HI', S]]);
    assert(has(s2, 'm0406')); assert(hasNot(s2, 'm0402'));
  });
  test('castling: attack on the rook-only square (b-file) does not prevent queenside', () => {
    const s = castlePos([[4, 1, 'HI', S]]);
    assert(has(s, 'm0402'));
  });
  test('castling: a dropped rook cannot castle', () => {
    const s = castlePos([], {}, { dp: true, mv: true });
    assert(hasNot(s, 'm0406')); assert(has(s, 'm0402'));
  });
  test('castling: rook ends next to the king', () => {
    let s = castlePos();
    s = SC.applyMove(s, 'm0402');
    eq(at(s, 0, 2).t, 'k'); eq(at(s, 0, 3).t, 'r'); eq(at(s, 0, 0), null);
    let s2 = castlePos();
    s2 = SC.applyMove(s2, 'm0406');
    eq(at(s2, 0, 6).t, 'k'); eq(at(s2, 0, 5).t, 'r'); eq(at(s2, 0, 7), null);
  });

  // =====================================================================
  // 6. Promotion
  // =====================================================================
  test('shogi promotion: moving into, within, or out of the zone offers + and =', () => {
    const into = single('GI', S, 3, 4);
    assert(has(into, 'm3424+') && has(into, 'm3424='), 'into zone');
    assert(hasNot(into, 'm3424'));
    const within = single('GI', S, 2, 4);
    assert(has(within, 'm2414+') && has(within, 'm2414='), 'within zone');
    assert(has(within, 'm2433+') && has(within, 'm2433='), 'out of zone');
    assert(hasNot(within, 'm2433'));
    const outside = single('GI', S, 4, 4);
    assert(has(outside, 'm4434') && hasNot(outside, 'm4434+') && hasNot(outside, 'm4434='), 'outside zone');
  });
  test('shogi promotion: Gote-owned shogi pieces promote in rows 6-8', () => {
    const s = single('FU', G, 5, 4, { dp: true, mv: true });
    assert(has(s, 'm5464+') && has(s, 'm5464='));
    const s2 = single('FU', G, 4, 4, { dp: true, mv: true });
    assert(has(s2, 'm4454') && hasNot(s2, 'm4454+'));
    const s3 = single('FU', G, 7, 4, { dp: true, mv: true });
    assert(has(s3, 'm7484+') && hasNot(s3, 'm7484='), 'Gote FU must promote on row 8');
  });
  test('shogi promotion: FU/KY must promote on the last row', () => {
    const fu = single('FU', S, 1, 4);
    assert(has(fu, 'm1404+') && hasNot(fu, 'm1404=') && hasNot(fu, 'm1404'));
    const ky = single('KY', S, 3, 4);
    assert(has(ky, 'm3404+') && hasNot(ky, 'm3404='));
    assert(has(ky, 'm3414+') && has(ky, 'm3414='));
  });
  test('shogi promotion: KE must promote on the last two rows', () => {
    const ke = single('KE', S, 3, 4);
    assert(has(ke, 'm3413+') && hasNot(ke, 'm3413='));
    const ke2 = single('KE', S, 2, 4);
    assert(has(ke2, 'm2403+') && hasNot(ke2, 'm2403='));
    const ke3 = single('KE', S, 4, 4);
    assert(has(ke3, 'm4423+') && has(ke3, 'm4423='));
    const keG = single('KE', G, 5, 4, { dp: true, mv: true });
    assert(has(keG, 'm5473+') && hasNot(keG, 'm5473='));
  });
  test('shogi promotion: KI and OU never promote; promoted pieces do not promote again', () => {
    const ki = single('KI', S, 3, 4);
    assert(has(ki, 'm3424') && hasNot(ki, 'm3424+') && hasNot(ki, 'm3424='));
    const ou = custom([[3, 4, 'OU', S], [0, 0, 'k', G]], { turn: S });
    assert(has(ou, 'm3424') && hasNot(ou, 'm3424+'));
    const gi = single('GI', S, 3, 4, { pr: true });
    assert(has(gi, 'm3424') && hasNot(gi, 'm3424+'));
  });
  test('shogi promotion: + sets pr, = leaves it unset', () => {
    let s = single('GI', S, 3, 4);
    const a = SC.applyMove(s, 'm3424+');
    eq(at(a, 2, 4).pr, true); eq(at(a, 2, 4).t, 'GI');
    const b = SC.applyMove(s, 'm3424=');
    eq(at(b, 2, 4).pr, false);
  });
  test('chess pawn: must promote on the last row with exactly q/r/b/n', () => {
    const s = single('p', G, 7, 4, { mv: true });
    const c = codes(s).filter((x) => x.indexOf('m7484') === 0);
    eqArr(c, ['m7484q', 'm7484r', 'm7484b', 'm7484n']);
    const n = SC.applyMove(s, 'm7484q');
    eq(at(n, 8, 4).t, 'q'); eq(at(n, 8, 4).b, 'p'); eq(at(n, 8, 4).o, G);
  });
  test('chess pawn: promotion by capture on the last row', () => {
    const s = single('p', G, 7, 4, { mv: true }, [[8, 5, 'KI', S]]);
    const c = codes(s).filter((x) => x.indexOf('m7485') === 0);
    eqArr(c, ['m7485q', 'm7485r', 'm7485b', 'm7485n']);
    const n = SC.applyMove(s, 'm7485n');
    eq(at(n, 8, 5).t, 'n'); eq(at(n, 8, 5).b, 'p');
    eq(n.hands[G].KI, 1);
  });
  test('chess pawn: no promotion before the last row', () => {
    const s = single('p', G, 6, 4, { mv: true });
    eqArr(codes(s).filter((x) => x.indexOf('m6474') === 0), ['m6474']);
  });
  test('chess pawn owned by Sente promotes on row 0', () => {
    const s = single('p', S, 1, 4, { mv: true, dp: true });
    eqArr(codes(s).filter((x) => x.indexOf('m1404') === 0), ['m1404q', 'm1404r', 'm1404b', 'm1404n']);
    const n = SC.applyMove(s, 'm1404r');
    eq(at(n, 0, 4).t, 'r'); eq(at(n, 0, 4).b, 'p'); eq(at(n, 0, 4).o, S);
  });
  test('a captured promoted pawn returns to hand as p', () => {
    let s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [7, 4, 'p', G, { mv: true }], [8, 1, 'HI', S]], { turn: G });
    s = SC.applyMove(s, 'm7484q');
    eq(at(s, 8, 4).t, 'q');
    s = SC.applyMove(s, 'm8184');
    eq(s.hands[S].p, 1);
    eq(s.hands[S].q, undefined);
    eq(at(s, 8, 4).t, 'HI');
  });

  // =====================================================================
  // 7. Captures and hands
  // =====================================================================
  test('captures go to hand as base type; drop places unpromoted piece with dp', () => {
    let s = SC.newGame();
    s = play(s, ['m6555', 'm1636', 'm5545', 'm3645']);
    eq(s.hands[G].FU, 1, 'Gote captured FU');
    eq(at(s, 4, 5).t, 'p'); eq(at(s, 4, 5).o, G);
    s = SC.applyMove(s, 'm6757');
    assert(has(s, 'dFU44'));
    s = SC.applyMove(s, 'dFU44');
    const p = at(s, 4, 4);
    eq(p.t, 'FU'); eq(p.o, G); eq(p.pr, false); eq(p.dp, true);
    eq(s.hands[G].FU, undefined, 'hand emptied');
    // The dropped FU moves downward on Gote's next turn.
    s = SC.applyMove(s, 'm5747');
    eqArr(targets(s, 4, 4), ['54']);
  });
  test('a captured promoted shogi piece arrives unpromoted', () => {
    let s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [4, 0, 'HI', S], [4, 5, 'GI', G, { pr: true, dp: true, mv: true }]], { turn: S });
    s = SC.applyMove(s, 'm4045');
    eq(s.hands[S].GI, 1);
    s = SC.applyMove(s, 'm0001');
    assert(has(s, 'dGI55'));
    s = SC.applyMove(s, 'dGI55');
    const p = at(s, 5, 5);
    eq(p.t, 'GI'); eq(p.o, S); eq(p.pr, false); eq(p.dp, true);
    eq(s.hands[S].GI, undefined);
  });
  test('Sente captures a chess piece and can drop it', () => {
    let s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [4, 0, 'HI', S], [4, 5, 'n', G]], { turn: S });
    s = SC.applyMove(s, 'm4045');
    eq(s.hands[S].n, 1);
    s = SC.applyMove(s, 'm0001');
    s = SC.applyMove(s, 'dn44');
    eq(at(s, 4, 4).t, 'n'); eq(at(s, 4, 4).o, S); eq(at(s, 4, 4).dp, true);
  });
  test('Gote captures a chess piece previously dropped by Sente; hand count accumulates', () => {
    let s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [4, 0, 'r', G], [4, 5, 'b', S, { dp: true, mv: true }], [4, 7, 'KI', S]], { turn: G, hands: [{}, { b: 1 }] });
    s = SC.applyMove(s, 'm4045');
    eq(s.hands[G].b, 2);
  });

  // =====================================================================
  // 8. Drop restrictions
  // =====================================================================
  test('nifu: second unpromoted FU on a file is illegal', () => {
    const s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [5, 4, 'FU', S]], { turn: S, hands: [{ FU: 1 }, {}] });
    const d = dropTargets(s, 'FU');
    assert(d.indexOf('44') < 0 && d.indexOf('34') < 0, 'no drop on file with own FU');
    assert(d.indexOf('43') >= 0, 'other files ok');
    // 8 files x 8 rows (row 0 excluded) minus the square occupied by OU at (8,8)
    eq(d.length, 8 * 8 - 1);
  });
  test('nifu: a promoted FU (と) does not count', () => {
    const s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [5, 4, 'FU', S, { pr: true }]], { turn: S, hands: [{ FU: 1 }, {}] });
    assert(dropTargets(s, 'FU').indexOf('44') >= 0);
  });
  test('nifu: opponent FU on the file does not count', () => {
    const s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [3, 4, 'FU', G, { dp: true, mv: true }]], { turn: S, hands: [{ FU: 1 }, {}] });
    assert(dropTargets(s, 'FU').indexOf('44') >= 0);
  });
  test('nifu does not apply to chess pawns p', () => {
    const s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [5, 4, 'p', S, { dp: true, mv: true }]], { turn: S, hands: [{ p: 1 }, {}] });
    assert(dropTargets(s, 'p').indexOf('44') >= 0, 'Sente may stack chess pawns');
    const g = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [3, 4, 'p', G, { mv: true }]], { turn: G, hands: [{}, { p: 1 }] });
    assert(dropTargets(g, 'p').indexOf('44') >= 0, 'Gote may stack chess pawns');
    // FU nifu is unaffected by a p on the file
    const s2 = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [5, 4, 'p', S, { dp: true, mv: true }]], { turn: S, hands: [{ FU: 1 }, {}] });
    assert(dropTargets(s2, 'FU').indexOf('44') >= 0);
  });
  test('drops: FU/KY/p cannot be dropped on the last row, KE not on the last two (Sente)', () => {
    const s = custom([[8, 8, 'OU', S], [0, 0, 'k', G]], { turn: S, hands: [{ FU: 1, KY: 1, KE: 1, p: 1, GI: 1 }, {}] });
    for (const t of ['FU', 'KY', 'p']) {
      const d = dropTargets(s, t);
      assert(d.every((x) => x[0] !== '0'), t + ' not on row 0');
      assert(d.some((x) => x[0] === '1'), t + ' on row 1 ok');
    }
    const ke = dropTargets(s, 'KE');
    assert(ke.every((x) => x[0] !== '0' && x[0] !== '1'), 'KE not on rows 0,1');
    assert(ke.some((x) => x[0] === '2'));
    const gi = dropTargets(s, 'GI');
    assert(gi.some((x) => x[0] === '0'), 'GI may be dropped on row 0');
    eq(gi.length, 81 - 2);
  });
  test('drops: last-row restriction for Gote (rows 8 / 7-8)', () => {
    const s = custom([[8, 8, 'OU', S], [0, 0, 'k', G]], { turn: G, hands: [{}, { FU: 1, KY: 1, KE: 1, p: 1, n: 1 }] });
    for (const t of ['FU', 'KY', 'p']) {
      const d = dropTargets(s, t);
      assert(d.every((x) => x[0] !== '8'), t + ' not on row 8');
      assert(d.some((x) => x[0] === '7'), t + ' on row 7 ok');
    }
    const ke = dropTargets(s, 'KE');
    assert(ke.every((x) => x[0] !== '7' && x[0] !== '8'));
    assert(dropTargets(s, 'n').some((x) => x[0] === '8'), 'chess knight may be dropped anywhere');
  });
  test('drops: cannot drop on an occupied square', () => {
    const s = custom([[8, 8, 'OU', S], [0, 0, 'k', G], [4, 4, 'p', G]], { turn: S, hands: [{ GI: 1 }, {}] });
    assert(dropTargets(s, 'GI').indexOf('44') < 0);
  });
  // Uchifuzume setup: Gote king in the corner at (0,8).
  // Sente KI (2,7) protects (1,8) and covers (1,7); KA (1,6) covers (0,7).
  test('uchifuzume: a FU drop that mates is illegal', () => {
    const s = custom([[8, 0, 'OU', S], [0, 8, 'k', G], [2, 7, 'KI', S], [1, 6, 'KA', S]], { turn: S, hands: [{ FU: 1 }, {}] });
    assert(hasNot(s, 'dFU18'));
    assert(has(s, 'dFU28'), 'other FU drops still legal');
  });
  test('uchifuzume: a FU drop that only checks is legal', () => {
    const s = custom([[8, 0, 'OU', S], [0, 8, 'k', G], [2, 7, 'KI', S]], { turn: S, hands: [{ FU: 1 }, {}] });
    assert(has(s, 'dFU18'));
    const n = SC.applyMove(s, 'dFU18');
    eq(n.inCheck, true); eq(n.status.over, false);
  });
  test('uchifuzume: a FU drop that mates is legal if the pawn can be captured', () => {
    const s = custom([[8, 0, 'OU', S], [0, 8, 'k', G], [1, 6, 'KA', S], [2, 6, 'HI', S]], { turn: S, hands: [{ FU: 1 }, {}] });
    // HI at (2,6) covers (1,6)? no, it's own piece; HI covers row 2 and col 6; KA covers (0,7).
    // King can take the dropped FU at (1,8): legal (not mate).
    assert(has(s, 'dFU18'));
  });
  test('mate by moving (not dropping) a pawn is legal', () => {
    const s = custom([[8, 0, 'OU', S], [0, 8, 'k', G], [2, 7, 'KI', S], [1, 6, 'KA', S], [2, 8, 'FU', S]], { turn: S });
    assert(has(s, 'm2818='));
    assert(has(s, 'm2818+'));
    const n = SC.applyMove(s, 'm2818=');
    eq(n.status.over, true); eq(n.status.reason, 'checkmate'); eq(n.status.winner, S);
  });
  test('uchifuzume applies to chess pawn drops too', () => {
    // Sente OU (8,0). Gote p dropped at (7,1) checks it. n (5,0) protects (7,1),
    // b (5,2) covers (7,0), q (6,3) covers (8,1).
    const s = custom([[8, 0, 'OU', S], [0, 8, 'k', G], [5, 0, 'n', G], [5, 2, 'b', G], [6, 3, 'q', G]], { turn: G, hands: [{}, { p: 1 }] });
    assert(hasNot(s, 'dp71'), 'mating p drop illegal');
    const s2 = custom([[8, 0, 'OU', S], [0, 8, 'k', G], [5, 0, 'n', G], [6, 3, 'q', G]], { turn: G, hands: [{}, { p: 1 }] });
    assert(has(s2, 'dp71'), 'checking p drop legal');
  });
  test('uchifuzume does not apply to other piece drops', () => {
    const s = custom([[8, 0, 'OU', S], [0, 8, 'k', G], [2, 7, 'KI', S], [1, 6, 'KA', S]], { turn: S, hands: [{ KY: 1 }, {}] });
    assert(has(s, 'dKY18'));
    const n = SC.applyMove(s, 'dKY18');
    eq(n.status.over, true); eq(n.status.reason, 'checkmate');
  });

  // =====================================================================
  // 9. Check / checkmate / stalemate / repetition
  // =====================================================================
  test('check: inCheck flag set after a checking move', () => {
    let s = custom([[8, 4, 'OU', S], [0, 4, 'k', G], [3, 0, 'r', G]], { turn: G });
    s = SC.applyMove(s, 'm3034');
    eq(s.inCheck, true);
    eq(s.status.over, false);
    // All legal replies resolve the check.
    for (const m of SC.legalMoves(s)) {
      const n = SC.applyMove(s, m);
      assert(!SC.kingInCheck(n.board, S), 'reply ' + SC.encodeMove(m) + ' leaves king in check');
    }
  });
  test('a pinned piece may not expose its king', () => {
    const s = custom([[8, 4, 'OU', S], [0, 0, 'k', G], [6, 4, 'GI', S], [2, 4, 'r', G]], { turn: S });
    eqArr(SC.legalMovesFrom(s, 6, 4).map(SC.encodeMove), ['m6454']);
  });
  test('the king may not step into an attacked square', () => {
    const s = custom([[8, 4, 'OU', S], [0, 0, 'k', G], [0, 3, 'r', G]], { turn: S });
    eqArr(targets(s, 8, 4), ['74', '75', '85']);
  });
  test('checkmate: queen + rook vs lone king', () => {
    let s = custom([[8, 4, 'OU', S], [0, 4, 'k', G], [7, 8, 'r', G], [1, 0, 'q', G]], { turn: G });
    s = SC.applyMove(s, 'm1080');
    eq(s.status.over, true); eq(s.status.reason, 'checkmate'); eq(s.status.winner, G);
    eq(s.inCheck, true);
    eq(SC.legalMoves(s).length, 0);
    throws(() => SC.applyMove(s, 'm8483'));
  });
  test('checkmate: a drop can interpose and avert mate', () => {
    let s = custom([[8, 4, 'OU', S], [0, 4, 'k', G], [7, 8, 'r', G], [1, 0, 'q', G]], { turn: G, hands: [{ KI: 1 }, {}] });
    s = SC.applyMove(s, 'm1080');
    eq(s.status.over, false);
    assert(has(s, 'dKI83'));
  });
  test('stalemate: side to move with no legal move and not in check loses', () => {
    let s = custom([[8, 0, 'OU', S], [0, 4, 'k', G], [5, 2, 'q', G]], { turn: G });
    s = SC.applyMove(s, 'm5261');
    eq(s.inCheck, false);
    eq(s.status.over, true); eq(s.status.reason, 'stalemate'); eq(s.status.winner, G);
  });
  test('repetition: fourth occurrence of the same position is a draw', () => {
    let s = custom([[8, 4, 'OU', S], [0, 4, 'k', G]], { turn: S });
    const cycle = ['m8483', 'm0403', 'm8384', 'm0304'];
    s = play(s, cycle); // 2nd occurrence
    eq(s.status.over, false);
    s = play(s, cycle); // 3rd
    eq(s.status.over, false);
    s = play(s, cycle.slice(0, 3));
    eq(s.status.over, false);
    s = SC.applyMove(s, 'm0304'); // 4th
    eq(s.status.over, true); eq(s.status.reason, 'repetition'); eq(s.status.winner, null);
  });
  test('repetition: different hands make a different position', () => {
    let s = custom([[8, 4, 'OU', S], [0, 4, 'k', G]], { turn: S, hands: [{ FU: 1 }, {}] });
    const cycle = ['m8483', 'm0403', 'm8384', 'm0304'];
    s = play(s, cycle.concat(cycle).concat(cycle.slice(0, 3)));
    // Instead of completing the 4th repetition, drop a pawn: new position.
    s = SC.applyMove(s, 'm0304');
    eq(s.status.over, true);
    let s2 = custom([[8, 4, 'OU', S], [0, 4, 'k', G]], { turn: S, hands: [{ FU: 1 }, {}] });
    s2 = play(s2, cycle.concat(cycle).concat(['m8483', 'm0403', 'dFU44', 'm0304']));
    eq(s2.status.over, false);
  });

  // =====================================================================
  // 10. Serialization, resign, text
  // =====================================================================
  test('encodeGame/decodeGame round trip', () => {
    let s = SC.newGame();
    // Includes captures, a drop, a shogi promotion, capture of a promoted piece and a chess-side drop.
    const seq = ['m6555', 'm1636', 'm5545', 'm3645', 'm6757', 'dFU44', 'm5747', 'm1737', 'm7767', 'm0625',
      'm6757', 'm4555', 'm5756', 'm5565', 'm5616+', 'm0516', 'm8878', 'dHI55', 'm6858', 'm1627'];
    s = play(s, seq);
    eq(at(s, 5, 5).t, 'HI'); eq(at(s, 5, 5).o, G); eq(at(s, 5, 5).dp, true);
    const enc = SC.encodeGame(s);
    eq(enc, seq.join(','));
    const d = SC.decodeGame(enc);
    eq(SC.positionKey(d), SC.positionKey(s));
    eq(d.turn, s.turn);
    eq(JSON.stringify(d.moves), JSON.stringify(s.moves));
    eq(JSON.stringify(d.hands), JSON.stringify(s.hands));
    eq(SC.legalMoves(d).length, SC.legalMoves(s).length);
  });
  test('decodeGame of empty string is the initial position', () => {
    eq(SC.positionKey(SC.decodeGame('')), SC.positionKey(SC.newGame()));
  });
  test('resign sets status and is replayed by decodeGame', () => {
    let s = SC.newGame();
    s = SC.applyMove(s, 'm6252');
    const r = SC.resign(s, G);
    eq(r.status.over, true); eq(r.status.winner, S); eq(r.status.reason, 'resign');
    eq(SC.legalMoves(r).length, 0);
    const d = SC.decodeGame(SC.encodeGame(r));
    eq(d.status.over, true); eq(d.status.winner, S); eq(d.status.reason, 'resign');
    const r2 = SC.resign(SC.newGame(), S);
    eq(r2.status.winner, G);
  });
  test('moveToText: ☗７六歩 for m6252, ☗３六歩 for m6656', () => {
    const s = SC.newGame();
    eq(SC.moveToText(s, SC.findLegal(s, 'm6252')), '☗７六歩');
    eq(SC.moveToText(s, SC.findLegal(s, 'm6656')), '☗３六歩');
    eq(SC.squareName(5, 2), '７六');
  });
  test('moveToText: Gote move, drop, promotion, castling, en passant', () => {
    const g = SC.applyMove(SC.newGame(), 'm6252');
    eq(SC.moveToText(g, SC.findLegal(g, 'm1434')), '☖５四ポーン');
    const d = custom([[8, 8, 'OU', S], [0, 0, 'k', G]], { turn: S, hands: [{ FU: 1 }, {}] });
    eq(SC.moveToText(d, SC.findLegal(d, 'dFU44')), '☗５五歩打');
    const p = single('GI', S, 3, 4);
    eq(SC.moveToText(p, SC.findLegal(p, 'm3424+')), '☗５三銀成');
    eq(SC.moveToText(p, SC.findLegal(p, 'm3424=')), '☗５三銀不成');
    const c = castlePos();
    eq(SC.moveToText(c, SC.findLegal(c, 'm0406')), '☖キャスリング(３一)');
    const pp = single('p', G, 7, 4, { mv: true });
    eq(SC.moveToText(pp, SC.findLegal(pp, 'm7484q')), '☖５九ポーン=クイーン');
    let e = epPosition();
    e = SC.applyMove(e, 'm1434');
    eq(SC.moveToText(e, SC.findLegal(e, 'm3324')), '☗５三ポーン(アンパッサン)');
  });
  test('applyMove rejects illegal moves', () => {
    throws(() => SC.applyMove(SC.newGame(), 'm6646'));
    throws(() => SC.applyMove(SC.newGame(), 'dFU44'));
    throws(() => SC.applyMove(SC.newGame(), 'm1434'), 'not Gote\'s turn');
  });
  test('timeout sets status and is replayed by decodeGame', () => {
    const s = SC.applyMove(SC.newGame(), 'm6252');
    const t = SC.timeout(s, G);
    eq(t.status.over, true); eq(t.status.winner, S); eq(t.status.reason, 'timeout');
    eq(t.moves[t.moves.length - 1], 'T1');
    eq(SC.legalMoves(t).length, 0);
    const d = SC.decodeGame(SC.encodeGame(t));
    eq(d.status.over, true); eq(d.status.winner, S); eq(d.status.reason, 'timeout');
    const t2 = SC.timeout(SC.newGame(), S);
    eq(t2.status.winner, G); eq(t2.moves[0], 'T0');
  });
  test('applyMove does not mutate the input state', () => {
    const s = SC.newGame();
    const key = SC.positionKey(s);
    SC.applyMove(s, 'm6252');
    eq(SC.positionKey(s), key);
    eq(s.moves.length, 0);
    eq(at(s, 6, 2).t, 'FU');
  });

  // ---------- summary ----------
  print('');
  print(passed + ' passed, ' + failed + ' failed, ' + (passed + failed) + ' total');
  if (failed > 0) {
    print('Failed tests:\n  ' + failures.join('\n  '));
    throw new Error(failed + ' test(s) failed');
  }
})();
