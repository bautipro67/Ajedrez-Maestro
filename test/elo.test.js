/**
 * elo.test.js — Propiedades del sistema de puntuacion.
 * Comprueba simetria y suma cero del Elo, la tabla dp de rendimiento,
 * la cobertura de los tramos de categoria y el ejemplo canonico de Glicko-2.
 */

import { test, assert, assertEqual, assertClose, run } from './harness.js';
import {
  expectedScore,
  kFactor,
  applyResult,
  performanceRating,
  ratingTier,
  ratingHistoryStats,
  provisionalRd,
  glicko2Update,
  RATING_TIERS,
  RATING_FLOOR
} from '../web/js/elo.js';

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

const DAY = 86400000;

test('expectedScore: rivales iguales dan 0.5', () => {
  assertEqual(expectedScore(1500, 1500), 0.5, 'mismos puntos deben dar 0.5');
  assertEqual(expectedScore(2700, 2700), 0.5, 'mismos puntos deben dar 0.5');
});

test('expectedScore: expectedScore(a,b) + expectedScore(b,a) === 1 exactamente', () => {
  const rng = mulberry32(20260913);
  for (let i = 0; i < 500; i += 1) {
    const a = Math.round(100 + rng() * 2800);
    const b = Math.round(100 + rng() * 2800);
    const sum = expectedScore(a, b) + expectedScore(b, a);
    assertEqual(sum, 1, 'la suma de esperanzas debe ser exactamente 1 para ' + a + ' vs ' + b);
  }
});

test('expectedScore: 400 puntos de diferencia dan ~0.909', () => {
  assertClose(expectedScore(1900, 1500), 0.90909, 1e-5, 'el favorito por 400 puntos espera 0.909');
  assertClose(expectedScore(1500, 1900), 0.09091, 1e-5, 'el rival espera 0.0909');
  assertClose(expectedScore(2400, 2000), 0.90909, 1e-5, 'la escala solo depende de la diferencia');
});

test('expectedScore: crece de forma monotona con la puntuacion propia', () => {
  let prev = -1;
  for (let r = 800; r <= 2600; r += 50) {
    const e = expectedScore(r, 1700);
    assert(e > prev, 'la esperanza debe crecer al subir la puntuacion');
    prev = e;
  }
});

test('kFactor: 40 provisional, 20 normal, 10 a partir de 2400', () => {
  assertEqual(kFactor(1500, 0), 40, 'sin partidas es provisional');
  assertEqual(kFactor(1500, 29), 40, '29 partidas siguen siendo provisionales');
  assertEqual(kFactor(1500, 30), 20, 'con 30 partidas el K baja a 20');
  assertEqual(kFactor(2399, 200), 20, 'por debajo de 2400 el K es 20');
  assertEqual(kFactor(2400, 200), 10, 'al alcanzar 2400 el K baja a 10');
  assertEqual(kFactor(2500, 10), 40, 'el provisional manda sobre el umbral de maestro');
  assertEqual(kFactor(2350, 200, 2410), 10, 'haber alcanzado 2400 mantiene el K en 10');
});

test('applyResult: simetria y suma cero con el mismo K', () => {
  const r = applyResult(1500, 1500, 1);
  assertEqual(r.a, 1510, 'el ganador sube 10 puntos entre iguales');
  assertEqual(r.b, 1490, 'el perdedor baja 10 puntos entre iguales');
  assertEqual(r.deltaA + r.deltaB, 0, 'el intercambio debe ser de suma cero');

  const draw = applyResult(1500, 1500, 0.5);
  assertEqual(draw.deltaA, 0, 'tablas entre iguales no mueven la puntuacion');
  assertEqual(draw.deltaB, 0, 'tablas entre iguales no mueven la puntuacion');

  const mirror = applyResult(1500, 1500, 0);
  assertEqual(mirror.deltaA, -10, 'perder entre iguales resta 10');
  assertEqual(mirror.deltaB, 10, 'ganar entre iguales suma 10');
});

test('applyResult: suma cero sobre 400 pares sembrados', () => {
  const rng = mulberry32(777);
  const scores = [0, 0.5, 1];
  for (let i = 0; i < 400; i += 1) {
    const a = Math.round(200 + rng() * 2100);
    const b = Math.round(200 + rng() * 2100);
    const s = scores[Math.floor(rng() * 3)];
    const r = applyResult(a, b, s);
    assertEqual(r.deltaA + r.deltaB, 0, 'suma cero para ' + a + ' vs ' + b + ' (' + s + ')');
    assertEqual(r.a - a, r.deltaA, 'el delta debe coincidir con la puntuacion final');
    assertEqual(r.b - b, r.deltaB, 'el delta debe coincidir con la puntuacion final');
  }
});

test('applyResult: ganar a alguien mucho mas fuerte da mas puntos', () => {
  const upset = applyResult(1500, 2000, 1).deltaA;
  const normal = applyResult(1500, 1500, 1).deltaA;
  const easy = applyResult(1500, 1000, 1).deltaA;
  assert(upset > normal, 'la sorpresa debe dar mas que ganar a un igual');
  assert(normal > easy, 'ganar a un rival mas debil debe dar menos');
  assert(easy >= 0, 'ganar nunca resta puntos');
  assertEqual(upset, 19, 'ganar a un rival 500 puntos mas fuerte da 19 con K=20');
  assertEqual(easy, 1, 'ganar a un rival 500 puntos mas debil da 1 con K=20');
});

test('applyResult: los perfiles con distinto K ya no son de suma cero', () => {
  const r = applyResult(1500, 1500, 1, { gamesA: 0, gamesB: 120 });
  assertEqual(r.kA, 40, 'el jugador provisional usa K=40');
  assertEqual(r.kB, 20, 'el jugador establecido usa K=20');
  assertEqual(r.deltaA, 20, 'el provisional gana 20');
  assertEqual(r.deltaB, -10, 'el establecido solo pierde 10');
});

test('applyResult: respeta el suelo de 100 puntos', () => {
  const r = applyResult(100, 2800, 0);
  assertEqual(r.a, RATING_FLOOR, 'nadie baja del suelo de 100');
  assertEqual(r.deltaA, 0, 'si se toca el suelo el delta es 0');
  const r2 = applyResult(104, 104, 0);
  assertEqual(r2.a, RATING_FLOOR, 'el resultado se recorta al suelo');
  assertEqual(r2.deltaA, -4, 'el delta refleja el recorte al suelo');
  assertEqual(r2.b, 114, 'el rival cobra su parte completa');
});

test('performanceRating: tabla dp de la FIDE', () => {
  const ten = new Array(10).fill(1500);
  assertEqual(performanceRating(ten, 5), 1500, '50 % rinde como la media de rivales');
  assertEqual(performanceRating(ten, 10), 2300, '100 % anade los 800 puntos de la tabla');
  assertEqual(performanceRating(ten, 0), 700, '0 % resta 800 puntos');
  assertEqual(performanceRating(ten, 7), 1649, '70 % anade 149 puntos');
  assertEqual(performanceRating(ten, 3), 1351, '30 % resta 149 puntos');
  assertEqual(performanceRating([], 0), null, 'sin rivales no hay rendimiento');
});

test('performanceRating: version lineal para muestras pequenas', () => {
  assertEqual(performanceRating([1600, 1600, 1600], 3), 2000, 'tres victorias suman 400 lineales');
  assertEqual(performanceRating([1600, 1600, 1600], 1.5), 1600, 'el 50 % iguala a la media');
  assertEqual(performanceRating([1500, 1700], 1), 1600, 'empate a la media con dos rivales');
  assertEqual(
    performanceRating([1500, 1500, 1500], 2, { method: 'fide' }),
    1625,
    'forzando la tabla FIDE el 67 % suma 125'
  );
  assertEqual(
    performanceRating(new Array(10).fill(1500), 7, { method: 'linear' }),
    1660,
    'forzando el modo lineal se usa la regla de los 400'
  );
});

test('ratingTier: 8 tramos en espanol sin huecos ni solapes', () => {
  assertEqual(RATING_TIERS.length, 8, 'deben existir 8 tramos');
  const names = RATING_TIERS.map((t) => t.name).join(',');
  assertEqual(
    names,
    'Novato,Principiante,Aficionado,Intermedio,Avanzado,Experto,Maestro,Gran Maestro',
    'los nombres de los tramos van en espanol y en orden'
  );
  for (let i = 0; i < RATING_TIERS.length - 1; i += 1) {
    assertEqual(
      RATING_TIERS[i].max + 1,
      RATING_TIERS[i + 1].min,
      'el tramo ' + RATING_TIERS[i].key + ' debe encajar con el siguiente'
    );
  }
  assertEqual(RATING_TIERS[0].min, 0, 'el primer tramo empieza en 0');
  assertEqual(RATING_TIERS[RATING_TIERS.length - 1].max, Infinity, 'el ultimo tramo no tiene techo');
  for (const tier of RATING_TIERS) {
    assert(/^#[0-9a-f]{6}$/i.test(tier.color), 'el color de ' + tier.key + ' debe ser hex');
    assert(tier.icon.length > 0, 'cada tramo necesita icono');
  }
});

test('ratingTier: cubre todo el rango de puntuaciones', () => {
  for (let elo = -200; elo <= 3400; elo += 1) {
    const tier = ratingTier(elo);
    assert(tier && typeof tier.name === 'string', 'todo valor debe tener tramo: ' + elo);
    if (elo >= 0) {
      assert(elo >= tier.min && elo <= tier.max, 'el tramo debe contener a ' + elo);
    }
  }
  assertEqual(ratingTier(599).key, 'novice', '599 sigue siendo Novato');
  assertEqual(ratingTier(600).key, 'beginner', '600 ya es Principiante');
  assertEqual(ratingTier(1299).key, 'amateur', '1299 es Aficionado');
  assertEqual(ratingTier(1300).key, 'intermediate', '1300 es Intermedio');
  assertEqual(ratingTier(2199).key, 'expert', '2199 es Experto');
  assertEqual(ratingTier(2200).key, 'master', '2200 es Maestro');
  assertEqual(ratingTier(2500).key, 'grandmaster', '2500 es Gran Maestro');
  assertEqual(ratingTier(3500).name, 'Gran Maestro', 'por encima de todo sigue siendo Gran Maestro');
  assertEqual(ratingTier(-50).key, 'novice', 'por debajo de cero se usa el primer tramo');
});

test('ratingHistoryStats: pico, minimo, ventana de 7 dias y rachas', () => {
  const base = 1700000000000;
  const history = [
    { ts: base - 10 * DAY, rating: 1500, result: 'win', opponent: 'ana' },
    { ts: base - 9 * DAY, rating: 1512, result: 'win', opponent: 'beto' },
    { ts: base - 8 * DAY, rating: 1524, result: 'win', opponent: 'caro' },
    { ts: base - 6 * DAY, rating: 1510, result: 'loss', opponent: 'dani' },
    { ts: base - 5 * DAY, rating: 1520, result: 'win', opponent: 'eva' },
    { ts: base - 3 * DAY, rating: 1515, result: 'draw', opponent: 'fran' },
    { ts: base - 1 * DAY, rating: 1530, result: 'win', opponent: 'gala' }
  ];
  const s = ratingHistoryStats(history);
  assertEqual(s.games, 7, 'siete entradas');
  assertEqual(s.peak, 1530, 'el pico es 1530');
  assertEqual(s.low, 1500, 'el minimo es 1500');
  assertEqual(s.current, 1530, 'la actual es la ultima');
  assertEqual(s.delta7d, 18, 'en 7 dias subio 18 puntos');
  assertEqual(s.wins, 5, 'cinco victorias');
  assertEqual(s.draws, 1, 'unas tablas');
  assertEqual(s.losses, 1, 'una derrota');
  assertClose(s.winRate, 5 / 7, 1e-9, 'el porcentaje de victorias es 5 de 7');
  assertClose(s.winPercent, 71.4, 1e-9, 'el porcentaje redondeado es 71.4');
  assertClose(s.scoreRate, 5.5 / 7, 1e-9, 'el rendimiento cuenta las tablas a medias');
  assertEqual(s.streak.type, 'win', 'la racha actual es de victorias');
  assertEqual(s.streak.count, 1, 'la racha actual es de una partida');
  assertEqual(s.bestStreak.count, 3, 'la mejor racha fue de tres victorias');
  assertEqual(s.delta, 30, 'la variacion total es de 30 puntos');
});

test('ratingHistoryStats: historial vacio y desordenado', () => {
  const empty = ratingHistoryStats([]);
  assertEqual(empty.games, 0, 'sin entradas no hay partidas');
  assertEqual(empty.peak, null, 'sin entradas no hay pico');
  assertEqual(empty.streak.count, 0, 'sin entradas no hay racha');

  const base = 1700000000000;
  const shuffled = ratingHistoryStats([
    { ts: base + 2 * DAY, rating: 1450, result: 'loss' },
    { ts: base, rating: 1400, result: 'win' },
    { ts: base + DAY, rating: 1480, result: 'win' }
  ]);
  assertEqual(shuffled.current, 1450, 'se ordena por marca de tiempo');
  assertEqual(shuffled.peak, 1480, 'el pico no depende del orden de entrada');
  assertEqual(shuffled.streak.type, 'loss', 'la ultima racha es de derrotas');
  assertEqual(shuffled.bestStreak.count, 2, 'la mejor racha fue de dos victorias');
});

test('provisionalRd: parte de 350 y baja de forma monotona', () => {
  assertEqual(provisionalRd(0), 350, 'sin partidas la incertidumbre es maxima');
  let prev = provisionalRd(0);
  for (let g = 1; g <= 200; g += 1) {
    const rd = provisionalRd(g);
    assert(rd <= prev, 'la RD no puede crecer con mas partidas (' + g + ')');
    assert(rd >= 50, 'la RD nunca baja del suelo de 50');
    prev = rd;
  }
  assert(provisionalRd(30) < 120, 'tras 30 partidas la RD ya es baja');
  assert(provisionalRd(5) < provisionalRd(1), 'cinco partidas informan mas que una');
});

test('glicko2Update: ejemplo canonico de Glickman', () => {
  const player = { rating: 1500, rd: 200, vol: 0.06 };
  const results = [
    { rating: 1400, rd: 30, score: 1 },
    { rating: 1550, rd: 100, score: 0 },
    { rating: 1700, rd: 300, score: 0 }
  ];
  const out = glicko2Update(player, results);
  assertClose(out.rating, 1464.06, 0.01, 'la puntuacion final debe ser 1464.06');
  assertClose(out.rd, 151.52, 0.01, 'la RD final debe ser 151.52');
  assertClose(out.vol, 0.05999, 0.00001, 'la volatilidad final debe ser 0.05999');
  assertEqual(out.games, 3, 'se han procesado tres partidas');
});

test('glicko2Update: sin partidas solo crece la incertidumbre', () => {
  const out = glicko2Update({ rating: 1500, rd: 200, vol: 0.06 }, []);
  assertEqual(out.rating, 1500, 'sin jugar la puntuacion no cambia');
  assert(out.rd > 200, 'sin jugar la RD aumenta');
  assertClose(out.rd, 200.2711, 0.001, 'la RD crece segun la volatilidad');
  assertEqual(out.vol, 0.06, 'la volatilidad no cambia sin partidas');
});

test('glicko2Update: ganar sube y perder baja, y la RD se estrecha', () => {
  const player = { rating: 1500, rd: 200, vol: 0.06 };
  const win = glicko2Update(player, [{ rating: 1500, rd: 50, score: 1 }]);
  const loss = glicko2Update(player, [{ rating: 1500, rd: 50, score: 0 }]);
  const draw = glicko2Update(player, [{ rating: 1500, rd: 50, score: 0.5 }]);
  assert(win.rating > 1500, 'ganar sube la puntuacion');
  assert(loss.rating < 1500, 'perder baja la puntuacion');
  assertClose(draw.rating, 1500, 1e-6, 'unas tablas entre iguales no mueven la puntuacion');
  assert(win.rd < 200, 'jugar reduce la incertidumbre');
  assertClose(win.rating - 1500, 1500 - loss.rating, 1e-6, 'ganar y perder son simetricos');
  assert(win.rating > applyResult(1500, 1500, 1).a, 'con RD alta el ajuste es mayor que el Elo clasico');
});

run('elo.js');
