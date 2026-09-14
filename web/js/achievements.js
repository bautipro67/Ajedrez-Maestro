/**
 * achievements.js — unlockable badges and the pure functions that decide them.
 * Every condition is checked against facts derived from the finished game plus
 * the player's profile, so nothing here needs the DOM or storage.
 */

export const ACHIEVEMENTS = [
  { id: 'primera-victoria', name: 'Primera sangre', icon: '🩸', hint: 'Gana tu primera partida.',
    check: (c) => c.result === 'win' },

  { id: 'cazador-de-bots', name: 'Cazador de bots', icon: '🎯', hint: 'Vence a 5 bots distintos.',
    check: (c) => (c.profile.defeatedBots || []).length >= 5 },

  { id: 'coleccionista', name: 'Coleccionista', icon: '🏵️', hint: 'Vence a 15 bots distintos.',
    check: (c) => (c.profile.defeatedBots || []).length >= 15 },

  { id: 'pleno', name: 'Pleno absoluto', icon: '👑', hint: 'Vence a todos los bots del plantel.',
    check: (c) => c.totalBots > 0 && (c.profile.defeatedBots || []).length >= c.totalBots },

  { id: 'matagigantes', name: 'Matagigantes', icon: '🗿', hint: 'Gánale a un rival con 300 puntos más que vos.',
    check: (c) => c.result === 'win' && c.f.opponentElo - c.f.myElo >= 300 },

  { id: 'imbatible', name: 'Contra la máquina', icon: '🤖', hint: 'Vence al bot más fuerte del plantel.',
    check: (c) => c.result === 'win' && c.f.opponentElo >= 2850 },

  { id: 'maestro-del-reloj', name: 'Maestro del reloj', icon: '⏱️', hint: 'Gana una partida por tiempo.',
    check: (c) => c.result === 'win' && c.f.wonOnTime },

  { id: 'al-limite', name: 'Al límite', icon: '😰', hint: 'Gana con menos de 5 segundos en el reloj.',
    check: (c) => c.result === 'win' && c.f.clockLeftMs != null && c.f.clockLeftMs < 5000 },

  { id: 'relampago', name: 'Relámpago', icon: '⚡', hint: 'Gana una partida de bala.',
    check: (c) => c.result === 'win' && c.f.category === 'bullet' },

  { id: 'maraton', name: 'Maratonista', icon: '🐢', hint: 'Gana una partida clásica.',
    check: (c) => c.result === 'win' && c.f.category === 'classical' },

  { id: 'mate-relampago', name: 'Mate fulminante', icon: '💥', hint: 'Da mate antes de la jugada 10.',
    check: (c) => c.result === 'win' && c.f.matedOpponent && c.f.matePly > 0 && c.f.matePly <= 20 },

  { id: 'mate-pastor', name: 'Mate del pastor', icon: '🐑', hint: 'Gana con un mate en 4 jugadas o menos.',
    check: (c) => c.result === 'win' && c.f.matedOpponent && c.f.matePly > 0 && c.f.matePly <= 8 },

  { id: 'promocion-menor', name: 'Subestimado', icon: '🐴', hint: 'Promociona a caballo y gana la partida.',
    check: (c) => c.result === 'win' && (c.f.promotedTo || []).includes('n') },

  { id: 'dos-damas', name: 'Doble monarquía', icon: '👸', hint: 'Ten dos damas tuyas en el tablero a la vez.',
    check: (c) => (c.f.maxOwnQueens || 0) >= 2 },

  { id: 'sacrificio', name: 'Sacrificio de dama', icon: '🔥', hint: 'Entrega la dama y gana igual.',
    check: (c) => c.result === 'win' && c.f.sacrificedQueen },

  { id: 'intacto', name: 'Sin un rasguño', icon: '🛡️', hint: 'Gana sin perder ni una sola pieza.',
    check: (c) => c.result === 'win' && c.f.lostNoPieces },

  { id: 'ahogado-salvador', name: 'Ahogado salvador', icon: '😅', hint: 'Salva medio punto por ahogado estando peor.',
    check: (c) => c.result === 'draw' && c.f.drawByStalemate && c.f.materialDiffAtEnd <= -3 },

  { id: 'final-tecnico', name: 'Final técnico', icon: '♟️', hint: 'Gana un final con 6 piezas o menos en el tablero.',
    check: (c) => c.result === 'win' && c.f.piecesAtEnd > 0 && c.f.piecesAtEnd <= 6 },

  { id: 'enroque-largo', name: 'Por el lado largo', icon: '🏰', hint: 'Gana una partida en la que enrocaste largo.',
    check: (c) => c.result === 'win' && c.f.castledSide === 'q' },

  { id: 'racha-5', name: 'En racha', icon: '🔥', hint: 'Gana 5 partidas seguidas.',
    check: (c) => (c.profile.stats.currentStreak || 0) >= 5 },

  { id: 'racha-10', name: 'Imparable', icon: '🌋', hint: 'Gana 10 partidas seguidas.',
    check: (c) => (c.profile.stats.currentStreak || 0) >= 10 },

  { id: 'centenario', name: 'Centenario', icon: '💯', hint: 'Juega 100 partidas.',
    check: (c) => totalGames(c.profile) >= 100 },

  { id: 'veterano', name: 'Veterano del club', icon: '🎖️', hint: 'Juega 500 partidas.',
    check: (c) => totalGames(c.profile) >= 500 },

  { id: 'campeon', name: 'Campeón', icon: '🏆', hint: 'Gana un torneo.',
    check: (c) => c.tournamentWon === true },

  { id: 'tricampeon', name: 'Tricampeón', icon: '🏆', hint: 'Gana 3 torneos.',
    check: (c) => (c.profile.stats.tournamentsWon || 0) >= 3 },

  { id: 'escalador', name: 'Escalador', icon: '📈', hint: 'Alcanza 1500 de Elo en cualquier categoría.',
    check: (c) => Object.values(c.profile.ratings || {}).some((r) => (r.rating || 0) >= 1500) },

  { id: 'experto', name: 'Rumbo a experto', icon: '🧠', hint: 'Alcanza 1900 de Elo en cualquier categoría.',
    check: (c) => Object.values(c.profile.ratings || {}).some((r) => (r.rating || 0) >= 1900) },

  { id: 'analista', name: 'Analista', icon: '🔬', hint: 'Analiza una partida terminada con el motor.',
    check: (c) => c.analyzedGame === true },
];

function totalGames(profile) {
  const s = profile.stats || {};
  return (s.wins || 0) + (s.losses || 0) + (s.draws || 0);
}

export function achievementById(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) || null;
}

/**
 * Returns the ids newly unlocked by this context (never re-reports old ones).
 * `ctx.f` holds the derived game facts from analyzeGame().
 */
export function evaluateAchievements(ctx) {
  const already = new Set(ctx.profile.achievements || []);
  const context = { ...ctx, f: ctx.f || {} };
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (already.has(a.id)) continue;
    let ok = false;
    try {
      ok = !!a.check(context);
    } catch {
      ok = false;
    }
    if (ok) unlocked.push(a.id);
  }
  return unlocked;
}

/**
 * Derive the facts used by the checks above from a finished game.
 *
 * @param {object} g
 *   sanMoves      array of SAN strings
 *   myColor       'w' | 'b'
 *   endReason     reason string from chess.js / game.js
 *   winnerColor   'w' | 'b' | null
 *   finalFen      FEN after the last move
 *   clockLeftMs   your remaining time, or null
 *   category      time control category
 *   myElo, opponentElo
 *   maxOwnQueens  highest simultaneous own queen count seen during play
 *   sacrificedQueen  true when you gave up your queen and still won
 */
export function analyzeGame(g) {
  const sanMoves = g.sanMoves || [];
  const mine = g.myColor === 'w' ? 0 : 1;
  const myMoves = sanMoves.filter((_, i) => i % 2 === mine);

  const promotedTo = [];
  for (const san of myMoves) {
    const m = /=([QRBN])/.exec(san);
    if (m) promotedTo.push(m[1].toLowerCase());
  }

  let castledSide = null;
  for (const san of myMoves) {
    if (/^O-O-O/.test(san)) castledSide = 'q';
    else if (/^O-O/.test(san)) castledSide = 'k';
  }

  const opponentCaptures = sanMoves.filter((_, i) => i % 2 !== mine).filter((s) => s.includes('x'));

  const board = (g.finalFen || '').split(' ')[0];
  const piecesAtEnd = board ? board.replace(/[^a-zA-Z]/g, '').length : 0;

  return {
    wonOnTime: g.endReason === 'timeout' && g.winnerColor === g.myColor,
    lostOnTime: g.endReason === 'timeout' && g.winnerColor !== g.myColor,
    drawByStalemate: g.endReason === 'stalemate',
    matedOpponent: g.endReason === 'checkmate' && g.winnerColor === g.myColor,
    matePly: g.endReason === 'checkmate' ? sanMoves.length : 0,
    promotedTo,
    castledSide,
    lostNoPieces: opponentCaptures.length === 0 && sanMoves.length > 10,
    piecesAtEnd,
    clockLeftMs: g.clockLeftMs == null ? null : g.clockLeftMs,
    category: g.category || 'casual',
    myElo: g.myElo || 0,
    opponentElo: g.opponentElo || 0,
    maxOwnQueens: g.maxOwnQueens || 0,
    sacrificedQueen: !!g.sacrificedQueen,
    materialDiffAtEnd: g.materialDiffAtEnd == null ? 0 : g.materialDiffAtEnd,
  };
}
