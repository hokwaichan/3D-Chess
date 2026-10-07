import { Chess } from 'chess.js';

// Search limits per difficulty. `randomness` is a centipawn margin: the engine
// picks at random among root moves scoring within that margin of the best.
export const LEVELS = {
  easy: { maxDepth: 1, timeMs: 500, randomness: 80 },
  medium: { maxDepth: 2, timeMs: 1500, randomness: 15 },
  hard: { maxDepth: 4, timeMs: 3000, randomness: 0 },
};

const INF = 1e9;
const MATE = 1e6;
const MAX_QUIESCE_DEPTH = 4;
const TIMEOUT = Symbol('timeout');

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Piece-square tables from white's point of view, index 0 = a8 (same layout as
// chess.board()). Mirrored vertically for black.
// prettier-ignore
const PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

// Static evaluation in centipawns, from the side to move's point of view.
function evaluate(chess) {
  const board = chess.board();
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      const white = piece.color === 'w';
      const value = VALUE[piece.type] + PST[piece.type][(white ? r : 7 - r) * 8 + f];
      score += white ? value : -value;
    }
  }
  return chess.turn() === 'w' ? score : -score;
}

// Most valuable victim / least valuable attacker, promotions first.
function moveOrderScore(m) {
  let score = 0;
  if (m.captured) score += 10 * VALUE[m.captured] - VALUE[m.piece];
  if (m.promotion) score += VALUE[m.promotion];
  return score;
}

function ordered(moves) {
  return moves.sort((a, b) => moveOrderScore(b) - moveOrderScore(a));
}

/**
 * Iterative-deepening alpha-beta search.
 * Returns `{ from, to, promotion }` or null when there is no legal move.
 */
export function findBestMove(fen, { maxDepth, timeMs, randomness }) {
  const chess = new Chess(fen);
  const deadline = performance.now() + timeMs;

  function quiesce(alpha, beta, depth) {
    const standPat = evaluate(chess);
    if (depth >= MAX_QUIESCE_DEPTH || standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;

    let best = standPat;
    const noisy = chess.moves({ verbose: true }).filter((m) => m.captured || m.promotion);
    for (const m of ordered(noisy)) {
      chess.move(m);
      const score = -quiesce(-beta, -alpha, depth + 1);
      chess.undo();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(depth, alpha, beta, ply) {
    if (performance.now() > deadline) throw TIMEOUT;
    if (depth <= 0) return quiesce(alpha, beta, 0);

    const moves = chess.moves({ verbose: true });
    // Prefer faster mates by making them score higher.
    if (!moves.length) return chess.isCheck() ? -MATE + ply : 0;

    let best = -INF;
    for (const m of ordered(moves)) {
      chess.move(m);
      const score = -negamax(depth - 1, -beta, -alpha, ply + 1);
      chess.undo();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  let rootMoves = ordered(chess.moves({ verbose: true }));
  if (!rootMoves.length) return null;
  let best = rootMoves[0];

  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      const scored = [];
      let alpha = -INF;
      for (const m of rootMoves) {
        chess.move(m);
        // Random picking needs exact scores for every root move, so it gives up
        // root pruning; otherwise later moves only have to beat the best so far.
        const score = -negamax(depth - 1, -INF, randomness ? INF : -alpha, 1);
        chess.undo();
        scored.push({ m, score });
        if (score > alpha) alpha = score;
      }
      // Stable sort: on ties the earlier move wins, which is the exact-scored one.
      scored.sort((a, b) => b.score - a.score);
      rootMoves = scored.map((s) => s.m);
      if (randomness) {
        const pool = scored.filter((s) => s.score >= scored[0].score - randomness);
        best = pool[Math.floor(Math.random() * pool.length)].m;
      } else {
        best = scored[0].m;
      }
    }
  } catch (e) {
    // Out of time: keep the result of the last fully searched depth.
    if (e !== TIMEOUT) throw e;
  }

  return { from: best.from, to: best.to, promotion: best.promotion };
}
