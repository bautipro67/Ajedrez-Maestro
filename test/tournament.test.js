/**
 * tournament.test.js — Propiedades del motor de torneos.
 * Recorre torneos completos de 6, 8, 11, 16 y 23 jugadores en los cuatro formatos
 * y comprueba emparejamientos, colores, byes, desempates y serializacion.
 */

import { test, assert, assertEqual, assertClose, run } from './harness.js';
import {
  createTournament,
  nextRound,
  reportResult,
  standings,
  isFinished,
  tournamentSummary,
  serialize,
  deserialize,
  pendingGames
} from '../web/js/tournament.js';

/** PRNG sembrado: los tests deben ser reproducibles. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), 1 | x);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makePlayers(n) {
  const players = [];
  for (let i = 0; i < n; i += 1) {
    players.push({
      id: 'p' + (i + 1),
      name: 'Jugador ' + (i + 1),
      elo: 1200 + ((i * 137) % 900),
      isHuman: i === 0,
      botId: i === 0 ? null : 'bot-' + (i + 1)
    });
  }
  return players;
}

function pickResult(rng) {
  const r = rng();
  if (r < 0.2) return '1/2-1/2';
  return r < 0.6 ? '1-0' : '0-1';
}

function pickDecisive(rng) {
  return rng() < 0.5 ? '1-0' : '0-1';
}

/** Juega un torneo entero resolviendo tambien las muertes subitas. */
function playTournament(t, rng, decisiveOnly = false) {
  let guard = 0;
  while (!isFinished(t) && guard < 60) {
    guard += 1;
    const pairings = nextRound(t);
    if (pairings.length === 0) break;
    let pending = pendingGames(t);
    let inner = 0;
    while (pending.length > 0 && inner < 40) {
      inner += 1;
      for (const g of pending) {
        reportResult(t, g.id, decisiveOnly ? pickDecisive(rng) : pickResult(rng));
      }
      pending = pendingGames(t);
    }
  }
  assert(guard < 60, 'el torneo debe terminar en un numero razonable de rondas');
  return t;
}

/** Resumen por jugador de rivales, colores y byes. */
function perPlayer(t) {
  const map = new Map();
  for (const p of t.players) {
    map.set(p.id, { opponents: [], colors: [], byes: 0, games: 0 });
  }
  for (const g of t.games) {
    if (g.result === 'bye') {
      const e = map.get(g.white);
      e.byes += 1;
      continue;
    }
    if (!g.result) continue;
    const w = map.get(g.white);
    const b = map.get(g.black);
    w.opponents.push(g.black);
    w.colors.push('w');
    w.games += 1;
    b.opponents.push(g.white);
    b.colors.push('b');
    b.games += 1;
  }
  return map;
}

function colorDiff(colors) {
  let d = 0;
  for (const c of colors) d += c === 'w' ? 1 : -1;
  return d;
}

function maxSameColorRun(colors) {
  let best = 0;
  let run = 0;
  let last = null;
  for (const c of colors) {
    run = c === last ? run + 1 : 1;
    last = c;
    if (run > best) best = run;
  }
  return best;
}

const SWISS_CASES = [
  { players: 6, rounds: 3 },
  { players: 8, rounds: 5 },
  { players: 11, rounds: 7 },
  { players: 16, rounds: 9 },
  { players: 23, rounds: 9 }
];

for (const cfg of SWISS_CASES) {
  test('suizo de ' + cfg.players + ' jugadores y ' + cfg.rounds + ' rondas', () => {
    const rng = mulberry32(1000 + cfg.players * 31 + cfg.rounds);
    const t = createTournament({
      id: 'sw' + cfg.players,
      name: 'Suizo de prueba',
      format: 'swiss',
      rounds: cfg.rounds,
      players: makePlayers(cfg.players),
      seed: 42
    });
    playTournament(t, rng);

    assertEqual(t.round, cfg.rounds, 'se deben jugar todas las rondas');
    assert(isFinished(t), 'el torneo debe quedar terminado');

    const stats = perPlayer(t);
    const byesPerRound = new Map();
    for (const g of t.games) {
      if (g.result === 'bye') byesPerRound.set(g.round, (byesPerRound.get(g.round) || 0) + 1);
    }
    for (let r = 1; r <= cfg.rounds; r += 1) {
      assertEqual(
        byesPerRound.get(r) || 0,
        cfg.players % 2,
        'la ronda ' + r + ' debe tener un bye solo si hay jugadores impares'
      );
    }

    for (const [id, e] of stats) {
      assertEqual(e.games + e.byes, cfg.rounds, id + ' debe jugar todas las rondas o tener un bye');
      assert(e.byes <= 1, id + ' no puede tener mas de un bye');
      const unique = new Set(e.opponents);
      assertEqual(unique.size, e.opponents.length, id + ' no puede repetir rival en un suizo');
      assert(Math.abs(colorDiff(e.colors)) <= 2, id + ' tiene los colores desequilibrados');
      assert(maxSameColorRun(e.colors) <= 2, id + ' juega tres veces seguidas del mismo color');
    }

    const table = standings(t);
    assertEqual(table.length, cfg.players, 'la clasificacion incluye a todos');
    const totalPoints = table.reduce((sum, row) => sum + row.points, 0);
    const decided = t.games.filter((g) => g.result && g.result !== 'bye').length;
    const byes = t.games.filter((g) => g.result === 'bye').length;
    assertClose(totalPoints, decided + byes, 1e-9, 'los puntos repartidos deben cuadrar');
    for (let i = 1; i < table.length; i += 1) {
      assert(table[i - 1].points >= table[i].points, 'la clasificacion debe ir de mas a menos puntos');
      assertEqual(table[i].rank, i + 1, 'los puestos deben ser consecutivos');
    }
  });
}

test('suizo: el bye va al jugador con menos puntos que aun no lo tuvo', () => {
  const rng = mulberry32(9090);
  const t = createTournament({
    id: 'bye',
    format: 'swiss',
    rounds: 5,
    players: makePlayers(7),
    seed: 7
  });
  playTournament(t, rng);
  const byGame = t.games.filter((g) => g.result === 'bye');
  assertEqual(byGame.length, 5, 'debe haber un bye por ronda');
  const receivers = byGame.map((g) => g.white);
  assertEqual(new Set(receivers).size, receivers.length, 'nadie puede repetir bye con 7 jugadores');
});

test('suizo: no se puede avanzar de ronda con partidas sin resultado', () => {
  const t = createTournament({ id: 'pend', format: 'swiss', rounds: 3, players: makePlayers(8), seed: 3 });
  nextRound(t);
  let threw = false;
  try {
    nextRound(t);
  } catch (e) {
    threw = true;
  }
  assert(threw, 'debe lanzarse un error si la ronda esta incompleta');
  assertEqual(pendingGames(t).length, 4, 'quedan cuatro partidas pendientes');
});

test('round robin: N jugadores producen N-1 rondas y cada par se ve una vez', () => {
  for (const n of [6, 8, 16]) {
    const rng = mulberry32(500 + n);
    const t = createTournament({ id: 'rr' + n, format: 'roundrobin', players: makePlayers(n), seed: 11 });
    assertEqual(t.rounds, n - 1, n + ' jugadores dan ' + (n - 1) + ' rondas');
    playTournament(t, rng);
    assertEqual(t.round, n - 1, 'se juegan todas las rondas');

    const seen = new Map();
    for (const g of t.games) {
      assert(g.result !== 'bye', 'con jugadores pares no hay byes');
      const key = [g.white, g.black].sort().join('|');
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    assertEqual(seen.size, (n * (n - 1)) / 2, 'deben aparecer todos los pares posibles');
    for (const [key, count] of seen) {
      assertEqual(count, 1, 'el par ' + key + ' solo puede jugarse una vez');
    }
    const stats = perPlayer(t);
    for (const [id, e] of stats) {
      assertEqual(e.games, n - 1, id + ' juega contra todos');
      assert(Math.abs(colorDiff(e.colors)) <= 2, id + ' tiene los colores desequilibrados');
    }
  }
});

test('round robin: con jugadores impares cada uno descansa una vez', () => {
  const rng = mulberry32(4242);
  const n = 11;
  const t = createTournament({ id: 'rr11', format: 'roundrobin', players: makePlayers(n), seed: 5 });
  assertEqual(t.rounds, n, 'con 11 jugadores hacen falta 11 rondas');
  playTournament(t, rng);
  const stats = perPlayer(t);
  for (const [id, e] of stats) {
    assertEqual(e.byes, 1, id + ' debe descansar exactamente una vez');
    assertEqual(e.games, n - 1, id + ' juega contra todos los demas');
    assertEqual(new Set(e.opponents).size, n - 1, id + ' no repite rival');
  }
});

test('round robin: la doble vuelta invierte los colores', () => {
  const rng = mulberry32(31337);
  const n = 6;
  const t = createTournament({
    id: 'rr6d',
    format: 'roundrobin',
    players: makePlayers(n),
    doubleRound: true,
    seed: 2
  });
  assertEqual(t.rounds, 2 * (n - 1), 'la doble vuelta dobla las rondas');
  playTournament(t, rng);
  const pairs = new Map();
  for (const g of t.games) {
    const key = [g.white, g.black].sort().join('|');
    const list = pairs.get(key) || [];
    list.push(g.white);
    pairs.set(key, list);
  }
  assertEqual(pairs.size, (n * (n - 1)) / 2, 'todos los pares se enfrentan');
  for (const [key, whites] of pairs) {
    assertEqual(whites.length, 2, 'el par ' + key + ' juega dos veces');
    assert(whites[0] !== whites[1], 'los colores se invierten en la segunda vuelta de ' + key);
  }
  const stats = perPlayer(t);
  for (const [id, e] of stats) {
    assertEqual(colorDiff(e.colors), 0, id + ' debe acabar con colores igualados');
  }
});

test('knockout: reduce a un unico campeon', () => {
  for (const n of [8, 11, 16, 23]) {
    const rng = mulberry32(70000 + n);
    const t = createTournament({ id: 'ko' + n, format: 'knockout', players: makePlayers(n), seed: 9 });
    const expectedRounds = Math.ceil(Math.log2(n));
    assertEqual(t.rounds, expectedRounds, n + ' jugadores necesitan ' + expectedRounds + ' rondas');
    playTournament(t, rng, true);
    assert(isFinished(t), 'el cuadro debe completarse');
    assertEqual(t.round, expectedRounds, 'se juegan todas las rondas del cuadro');

    const size = Math.pow(2, expectedRounds);
    const firstRoundByes = t.games.filter((g) => g.round === 1 && g.result === 'bye').length;
    assertEqual(firstRoundByes, size - n, 'los byes iniciales cubren el cuadro');

    const summary = tournamentSummary(t);
    assert(summary.champion !== null, 'debe haber campeon');
    assertEqual(summary.podium.length, 3, 'el podio tiene tres puestos');
    assertEqual(summary.prizes[0].label, 'Campeon', 'el primer premio es para el campeon');

    const finals = t.games.filter((g) => g.round === expectedRounds);
    const finalGame = finals[finals.length - 1];
    const winner = finalGame.result === '1-0' ? finalGame.white : finalGame.black;
    assertEqual(summary.champion.playerId, winner, 'el campeon es quien gana la final');

    // Nadie sigue jugando despues de perder.
    const eliminated = new Set();
    for (const g of t.games) {
      if (g.result === 'bye') continue;
      assert(!eliminated.has(g.white) && !eliminated.has(g.black), 'un eliminado no vuelve a jugar');
      eliminated.add(g.result === '1-0' ? g.black : g.white);
    }
  }
});

test('knockout: los cabezas de serie reciben los byes de la primera ronda', () => {
  const t = createTournament({ id: 'ko11', format: 'knockout', players: makePlayers(11), seed: 4 });
  const first = nextRound(t);
  const byes = first.filter((g) => g.black === null).map((g) => g.white);
  assertEqual(byes.length, 5, '11 jugadores en un cuadro de 16 dejan 5 byes');
  const byElo = t.players.slice().sort((a, b) => b.elo - a.elo);
  const topFive = new Set(byElo.slice(0, 5).map((p) => p.id));
  for (const id of byes) {
    assert(topFive.has(id), 'el bye debe ir a un cabeza de serie, no a ' + id);
  }
});

test('knockout: unas tablas provocan muerte subita con colores invertidos', () => {
  const t = createTournament({ id: 'kosd', format: 'knockout', players: makePlayers(4), seed: 8 });
  const first = nextRound(t);
  const game = first[0];
  const res = reportResult(t, game.id, '1/2-1/2');
  assert(res.tiebreak !== null, 'las tablas deben generar un desempate');
  assertEqual(res.tiebreak.white, game.black, 'la muerte subita invierte los colores');
  assertEqual(res.tiebreak.black, game.white, 'la muerte subita invierte los colores');
  assertEqual(res.tiebreak.round, game.round, 'el desempate pertenece a la misma ronda');
  assert(res.tiebreak.suddenDeath, 'el desempate queda marcado como muerte subita');

  const again = reportResult(t, res.tiebreak.id, '1/2-1/2');
  assert(again.tiebreak !== null, 'unas segundas tablas encadenan otro desempate');
  reportResult(t, again.tiebreak.id, '1-0');
  reportResult(t, first[1].id, '1-0');

  const second = nextRound(t);
  assertEqual(second.length, 1, 'la segunda ronda es la final');
  const survivors = [second[0].white, second[0].black];
  assert(survivors.includes(again.tiebreak.white), 'quien gana la muerte subita avanza');
  reportResult(t, second[0].id, '0-1');
  assert(isFinished(t), 'el torneo termina con la final');
});

test('arena: emparejamiento continuo y puntuacion de racha', () => {
  const rng = mulberry32(2024);
  const t = createTournament({ id: 'ar8', format: 'arena', rounds: 7, players: makePlayers(8), seed: 6 });
  playTournament(t, rng);
  assertEqual(t.round, 7, 'se juegan las siete rondas');
  const stats = perPlayer(t);
  for (const [id, e] of stats) {
    assertEqual(e.games + e.byes, 7, id + ' participa en todas las rondas');
  }

  const duel = createTournament({
    id: 'ar2',
    format: 'arena',
    rounds: 4,
    players: makePlayers(2),
    seed: 1
  });
  for (let r = 0; r < 4; r += 1) {
    const pairings = nextRound(duel);
    assertEqual(pairings.length, 1, 'dos jugadores dan una partida por ronda');
    const g = pairings[0];
    reportResult(duel, g.id, g.white === 'p1' ? '1-0' : '0-1');
  }
  const table = standings(duel);
  const winner = table.find((row) => row.playerId === 'p1');
  const loser = table.find((row) => row.playerId === 'p2');
  assertEqual(winner.points, 12, 'dos victorias a 2 y dos con racha a 4 suman 12');
  assertEqual(loser.points, 0, 'perder siempre no da puntos');
  assertEqual(winner.wins, 4, 'cuatro victorias');
  assertEqual(winner.bestStreak, 4, 'la mejor racha es de cuatro');
});

test('arena: las tablas cortan la racha', () => {
  const t = createTournament({ id: 'ar2b', format: 'arena', rounds: 5, players: makePlayers(2), seed: 1 });
  const plan = ['1-0', '1-0', '1/2-1/2', '1-0', '1-0'];
  for (let r = 0; r < plan.length; r += 1) {
    const g = nextRound(t)[0];
    const flip = g.white === 'p1' ? plan[r] : plan[r] === '1-0' ? '0-1' : plan[r];
    reportResult(t, g.id, flip);
  }
  const row = standings(t).find((x) => x.playerId === 'p1');
  // 2 + 2 (racha activada) + 1 (tablas, corta) + 2 + 2 = 9
  assertEqual(row.points, 9, 'las tablas reinician la racha');
});

test('standings: los desempates ordenan de forma estable', () => {
  const beats = {
    'p1|p2': 'p1',
    'p1|p3': 'p1',
    'p1|p4': 'p4',
    'p2|p3': 'p2',
    'p2|p4': 'p2',
    'p3|p4': 'p3'
  };
  const t = createTournament({
    id: 'tb',
    format: 'roundrobin',
    players: makePlayers(4),
    seed: 13
  });
  let guard = 0;
  while (!isFinished(t) && guard < 10) {
    guard += 1;
    for (const g of nextRound(t)) {
      const key = [g.white, g.black].sort().join('|');
      const winner = beats[key];
      reportResult(t, g.id, winner === g.white ? '1-0' : '0-1');
    }
  }
  const table = standings(t);
  assertEqual(table[0].playerId, 'p1', 'p1 gana el desempate directo contra p2');
  assertEqual(table[1].playerId, 'p2', 'p2 queda segundo');
  assertEqual(table[2].playerId, 'p3', 'p3 gana el directo a p4');
  assertEqual(table[3].playerId, 'p4', 'p4 cierra la tabla');
  assertEqual(table[0].points, 2, 'p1 suma dos puntos');
  assertEqual(table[1].points, 2, 'p2 suma dos puntos');
  assertEqual(table[0].rank, 1, 'el puesto se asigna por orden');

  const repeated = standings(t);
  assertEqual(
    repeated.map((r) => r.playerId).join(','),
    table.map((r) => r.playerId).join(','),
    'la clasificacion debe ser estable entre llamadas'
  );
  for (const row of table) {
    assertEqual(row.played, 3, 'todos juegan tres partidas');
    assert(Number.isFinite(row.buchholz), 'el Buchholz debe ser numerico');
    assert(Number.isFinite(row.buchholzCut), 'el Buchholz recortado debe ser numerico');
    assert(Number.isFinite(row.sonnebornBerger), 'el Sonneborn-Berger debe ser numerico');
    assert(Number.isFinite(row.performance), 'el rendimiento debe ser numerico');
  }
  const p1 = table[0];
  assertEqual(p1.buchholz, 4, 'p1 se enfrento a rivales que suman 4 puntos');
  assertEqual(p1.buchholzCut, 3, 'el Buchholz recortado quita al peor rival');
  assertEqual(p1.sonnebornBerger, 3, 'el Sonneborn-Berger de p1 es 3');
});

test('standings: la variacion de puntuacion es de suma cero con el mismo K', () => {
  const rng = mulberry32(5150);
  const t = createTournament({
    id: 'delta',
    format: 'swiss',
    rounds: 5,
    players: makePlayers(8),
    seed: 21
  });
  playTournament(t, rng);
  const table = standings(t);
  const total = table.reduce((sum, row) => sum + row.ratingChange, 0);
  assertClose(total, 0, 1e-9, 'los puntos que ganan unos los pierden otros');
  const winner = table[0];
  assert(winner.ratingChange > 0 || winner.points === 0, 'el lider deberia ganar puntuacion');
  for (const row of table) {
    assert(Number.isFinite(row.performance), 'el rendimiento debe calcularse');
  }
});

test('serialize/deserialize: ciclo exacto a mitad de torneo y al final', () => {
  const formats = [
    { format: 'swiss', players: 11, rounds: 5, seed: 3 },
    { format: 'roundrobin', players: 6, rounds: 0, seed: 4 },
    { format: 'knockout', players: 11, rounds: 0, seed: 5 },
    { format: 'arena', players: 8, rounds: 4, seed: 6 }
  ];
  for (const cfg of formats) {
    const rng = mulberry32(800 + cfg.players);
    const t = createTournament({
      id: 'ser-' + cfg.format,
      name: 'Torneo ' + cfg.format,
      format: cfg.format,
      rounds: cfg.rounds || undefined,
      players: makePlayers(cfg.players),
      timeControl: { base: 180, inc: 2 },
      seed: cfg.seed
    });

    // Dos rondas jugadas y comprobacion del ciclo.
    for (let r = 0; r < 2 && !isFinished(t); r += 1) {
      nextRound(t);
      let pending = pendingGames(t);
      let guard = 0;
      while (pending.length > 0 && guard < 20) {
        guard += 1;
        for (const g of pending) reportResult(t, g.id, pickDecisive(rng));
        pending = pendingGames(t);
      }
    }
    const snapshot = JSON.stringify(serialize(t));
    const copy = deserialize(JSON.parse(snapshot));
    assertEqual(JSON.stringify(serialize(copy)), snapshot, 'el ciclo debe ser exacto en ' + cfg.format);
    assertEqual(
      JSON.stringify(standings(copy)),
      JSON.stringify(standings(t)),
      'la clasificacion debe sobrevivir al ciclo en ' + cfg.format
    );

    // Continuar desde la copia produce exactamente el mismo torneo.
    const rngA = mulberry32(99);
    const rngB = mulberry32(99);
    playTournament(t, rngA, true);
    playTournament(copy, rngB, true);
    assertEqual(
      JSON.stringify(serialize(copy)),
      JSON.stringify(serialize(t)),
      'la copia debe evolucionar igual que el original en ' + cfg.format
    );
    assertEqual(
      JSON.stringify(tournamentSummary(copy)),
      JSON.stringify(tournamentSummary(t)),
      'el resumen final debe coincidir en ' + cfg.format
    );
  }
});

test('createTournament: valida la configuracion', () => {
  let threw = false;
  try {
    createTournament({ format: 'suizo', players: makePlayers(4) });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'un formato desconocido debe fallar');

  threw = false;
  try {
    createTournament({ format: 'swiss', players: makePlayers(1) });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'un torneo de un solo jugador debe fallar');

  threw = false;
  try {
    const dup = makePlayers(3);
    dup[2].id = 'p1';
    createTournament({ format: 'swiss', players: dup });
  } catch (e) {
    threw = true;
  }
  assert(threw, 'no se admiten identificadores repetidos');
});

test('reportResult: valida partidas y resultados', () => {
  const t = createTournament({ id: 'val', format: 'swiss', rounds: 2, players: makePlayers(5), seed: 2 });
  const pairings = nextRound(t);
  const game = pairings.find((g) => g.black !== null);
  const bye = pairings.find((g) => g.black === null);

  let threw = false;
  try {
    reportResult(t, game.id, '2-0');
  } catch (e) {
    threw = true;
  }
  assert(threw, 'un resultado invalido debe fallar');

  threw = false;
  try {
    reportResult(t, 'no-existe', '1-0');
  } catch (e) {
    threw = true;
  }
  assert(threw, 'una partida inexistente debe fallar');

  threw = false;
  try {
    reportResult(t, bye.id, '1-0');
  } catch (e) {
    threw = true;
  }
  assert(threw, 'un bye no admite resultado');

  reportResult(t, game.id, '1-0');
  threw = false;
  try {
    reportResult(t, game.id, '0-1');
  } catch (e) {
    threw = true;
  }
  assert(threw, 'no se puede reportar dos veces la misma partida');
});

/* --------------- lo que no se veia hasta que alguien lo busco ------------ */

test('el campeón no depende del orden en que se inscribió la gente', () => {
  /* Con un triángulo entre los empatados —A gana a B, B a C, C a A— comparar
     de a dos por el enfrentamiento directo no da ningún orden, y Array.sort
     devuelve lo que le salga según dónde estuviera cada uno. Con las mismas
     partidas y los mismos resultados salían tres campeones distintos. */
  const GANA = {
    'p1|p2': 'p1', 'p2|p3': 'p2', 'p1|p3': 'p3',
    'p1|p4': 'p1', 'p2|p4': 'p2', 'p3|p4': 'p4',
    'p1|p5': 'p1', 'p2|p5': 'p2', 'p3|p5': 'p3', 'p4|p5': 'p4',
    'p1|p6': 'p1', 'p2|p6': 'p2', 'p3|p6': 'p3', 'p4|p6': 'p4', 'p5|p6': 'p5',
  };
  const jugar = (orden) => {
    const players = orden.map((id, i) => ({ id, name: id, elo: 1500, seed: i }));
    const t = createTournament({ id: 'ciclo', format: 'roundrobin', players, seed: 7 });
    let guarda = 0;
    while (!isFinished(t) && guarda++ < 20) {
      for (const g of nextRound(t)) {
        if (!g.white || !g.black) continue;
        const gana = GANA[[g.white, g.black].sort().join('|')];
        reportResult(t, g.id, gana === g.white ? '1-0' : '0-1');
      }
    }
    return standings(t).map((r) => r.playerId).join(',');
  };
  const base = jugar(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  for (const orden of [
    ['p3', 'p1', 'p2', 'p4', 'p5', 'p6'],
    ['p2', 'p3', 'p1', 'p4', 'p5', 'p6'],
    ['p6', 'p5', 'p4', 'p3', 'p2', 'p1'],
  ]) {
    assertEqual(jugar(orden), base,
      'inscribiendo en otro orden salió otra clasificación: ' + orden.join(','));
  }
});

test('un resultado que no se reconoce no le regala la partida a nadie', () => {
  /* En computeStats las blancas suman `scoreFromResult(...)`, que es null si el
     resultado no se entiende, y las negras `1 - null`, que es 1. Unas tablas
     guardadas como «1/2» se convertían en victoria de las negras, en silencio. */
  const t = createTournament({ id: 'raro', format: 'roundrobin', players: makePlayers(4), seed: 3 });
  nextRound(t);
  const guardado = serialize(t);
  guardado.games[0].result = '1/2';        // no es '1/2-1/2'
  guardado.games[1].result = '';           // ni esto
  const vuelto = deserialize(guardado);
  assertEqual(vuelto.games[0].result, null, 'la basura vuelve como partida sin jugar');
  assertEqual(vuelto.games[1].result, null, 'y la cadena vacía también');
  const tabla = standings(vuelto);
  for (const fila of tabla) {
    assertEqual(fila.points, 0, fila.playerId + ' no jugó nada y no puede tener puntos');
  }
  assert(pendingGames(vuelto).length >= 2,
    'y esas partidas tienen que seguir pendientes, no desaparecer del torneo');
});

test('un guardado sin el calendario o sin el cuadro se rechaza al leerlo', () => {
  /* Entraba sin protestar y reventaba al pulsar «siguiente ronda», con la
     pantalla muerta y un TypeError en la consola. */
  const liga = createTournament({ id: 'l', format: 'roundrobin', players: makePlayers(4), seed: 1 });
  nextRound(liga);
  const sinCalendario = serialize(liga);
  delete sinCalendario.schedule;
  let fallo = null;
  try { deserialize(sinCalendario); } catch (err) { fallo = err; }
  assert(fallo, 'una liga empezada sin calendario tiene que dar error al leerla');

  const cuadro = createTournament({ id: 'k', format: 'knockout', players: makePlayers(4), seed: 1 });
  nextRound(cuadro);
  const sinCuadro = serialize(cuadro);
  delete sinCuadro.knockout;
  fallo = null;
  try { deserialize(sinCuadro); } catch (err) { fallo = err; }
  assert(fallo, 'una eliminatoria empezada sin cuadro también');
});

test('un guardado sin el número de rondas se rechaza en vez de darse por acabado', () => {
  const t = createTournament({ id: 'sr', format: 'swiss', players: makePlayers(6), rounds: 5, seed: 2 });
  for (const g of nextRound(t)) {
    if (g.white && g.black) reportResult(t, g.id, '1-0');
  }
  const guardado = serialize(t);
  delete guardado.rounds;
  let fallo = null;
  try { deserialize(guardado); } catch (err) { fallo = err; }
  assert(fallo, 'sin el número de rondas hay que decirlo, no dar el torneo por acabado');

  /* Y con el dato, el mismo guardado se lee bien y sigue a medias. */
  const bueno = deserialize(serialize(t));
  assert(!isFinished(bueno), 'con sus cinco rondas, en la primera no ha terminado');
});

run('tournament.js');
