/**
 * bots.js — el plantel de rivales: los personajes, la curva que traduce un Elo
 * en limites de motor, y la eleccion de jugada que los hace parecer humanos.
 * Agnostico del entorno: sin DOM y sin azar propio; todo el azar entra por el
 * `rng` que le pasa quien llama, asi que una semilla replica la partida entera.
 */

import { ratingTier } from './elo.js';
import {
  PAWN, QUEEN,
  makeMove, unmakeMove, inCheck,
  moveFrom, moveTo, movePromo, isCapture, isCastle,
  sqFile, pieceType,
} from './chess.js';

/** Los ocho momentos en los que un bot dice algo. */
export const BOT_EVENTS = Object.freeze([
  'greeting', 'win', 'lose', 'draw', 'blunder', 'check', 'brilliant', 'thinking',
]);

/* Valores de pieza solo para los sesgos humanos; la evaluacion de verdad vive
   en eval.js. Se duplican aqui a proposito para no acoplar los bots al motor. */
const VALUES = [0, 100, 325, 335, 500, 975, 0];

/* Por debajo de esto una puntuacion es "me dan mate": nunca se elige a drede. */
const LOST_SCORE = -20000;

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/* --------------------------- curva de fuerza ---------------------------- */

/**
 * Traduce un Elo en limites de motor. Lo que de verdad regula la fuerza no es
 * la profundidad sino el tope de nodos, el ruido en la evaluacion y la
 * temperatura: un bot de 800 "ve" poco y ademas elige mal entre lo que ve.
 */
export function strengthProfile(elo) {
  const rating = clamp(Math.round(Number(elo) || 250), 250, 2900);
  const t = (rating - 250) / 2650;
  const decay = (power) => Math.pow(1 - t, power);

  const quiescence = rating >= 900;
  return {
    depth: clamp(Math.round(1 + t * 16), 1, 18),
    nodes: Math.round(200 * Math.pow(10, t * 3.8)),
    timeMs: clamp(Math.round(40 + t * 2400), 40, 2600),
    evalNoise: Math.round(180 * decay(2.2)),
    blunderRate: Math.round(380 * decay(1.9)) / 1000,
    tacticalBlindness: Math.round(450 * decay(2.1)) / 1000,
    temperature: Math.max(6, Math.round(320 * decay(1.6))),
    quiescence,
    maxQDepth: quiescence ? clamp(2 + Math.round(t * 7), 2, 8) : 0,
    thinkMs: [Math.round(250 + t * 600), Math.round(900 + t * 2600)],
  };
}

/* ---------------------------- sesgos humanos ---------------------------- */

/** Hace la jugada, mira si es jaque y la deshace. `pos` queda igual. */
function givesCheck(pos, move) {
  makeMove(pos, move);
  const checked = inCheck(pos);
  unmakeMove(pos);
  return checked;
}

/**
 * Centipeones de "atractivo" que un jugador flojo le ve a una jugada, al
 * margen de lo buena que sea: las capturas llaman, los jaques llaman mucho,
 * la dama sale pronto, los peones de torre se empujan sin motivo y el enroque
 * se olvida. `naive` (0..1) sale de la temperatura: con un bot fuerte es ~0 y
 * todo esto desaparece.
 */
function humanBias(move, pos, naive, moveNumber, losing) {
  if (naive <= 0.02 || !pos) return 0;

  const board = pos.board;
  const mover = pieceType(board[moveFrom(move)]);
  let bonus = 0;

  if (isCapture(move)) {
    /* Al paso deja la casilla de destino vacia: ahi la victima es un peon. */
    const victim = pieceType(board[moveTo(move)]);
    bonus += 38 + (VALUES[victim] || 100) / 12;
  }
  if (movePromo(move) !== 0) bonus += 30;
  if (mover === QUEEN && moveNumber <= 8) bonus += 34;
  if (mover === PAWN) {
    const file = sqFile(moveFrom(move));
    if (file === 0 || file === 7) bonus += 16;
  }
  if (isCastle(move)) bonus -= 10;
  /* Ir perdiendo pone nervioso: se dan mas jaques inutiles. */
  if (givesCheck(pos, move)) bonus += losing ? 60 : 42;

  return bonus * naive;
}

/** Eleccion por softmax sobre `adjusted`, con el rng de quien llama. */
function softmaxPick(entries, temperature, random) {
  let max = -Infinity;
  for (const entry of entries) {
    if (entry.adjusted > max) max = entry.adjusted;
  }
  const weights = new Array(entries.length);
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    const weight = Math.exp((entries[i].adjusted - max) / temperature);
    weights[i] = weight;
    total += weight;
  }
  let roll = random() * total;
  for (let i = 0; i < entries.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return entries[i];
  }
  return entries[entries.length - 1];
}

/**
 * Elige UNA jugada entre las que el motor puntuo en la raiz. Determinista dado
 * `rng`. `rootMoves` viene de `searcher.searchRoot` ya ordenado y con la
 * puntuacion de cada jugada legal; `ctx` es `{pos, moveNumber, myColor,
 * inCheck, materialDiff}`.
 */
export function chooseBotMove(rootMoves, profile, rng, ctx = {}) {
  if (!Array.isArray(rootMoves) || rootMoves.length === 0) return 0;
  if (rootMoves.length === 1) return rootMoves[0].move;

  const random = typeof rng === 'function' ? rng : Math.random;
  const temperature = Math.max(1, Number(profile && profile.temperature) || 1);
  const blunderRate = clamp(Number(profile && profile.blunderRate) || 0, 0, 1);
  const naive = clamp(temperature / 320, 0, 1);

  const pos = ctx.pos || null;
  const moveNumber = Number(ctx.moveNumber) || 1;
  const losing = Number(ctx.materialDiff) < -150;

  const scored = rootMoves.map((entry) => {
    const score = Number(entry.score) || 0;
    return {
      move: entry.move,
      score,
      adjusted: score + humanBias(entry.move, pos, naive, moveNumber, losing),
    };
  });

  let best = scored[0];
  for (const entry of scored) {
    if (entry.adjusted > best.adjusted) best = entry;
  }

  /* El error deliberado: una jugada mala pero de las que se juegan de verdad,
     nunca un disparate ni meterse en un mate. */
  if (blunderRate > 0 && random() < blunderRate) {
    const floor = best.score - 650;
    const ceiling = best.score - 90;
    const candidates = scored.filter((entry) => entry !== best &&
      entry.score >= floor && entry.score <= ceiling && entry.score > LOST_SCORE);
    if (candidates.length > 0) {
      /* Entre las malas, la que mas entra por los ojos. */
      return softmaxPick(candidates, 80, random).move;
    }
  }

  return softmaxPick(scored, temperature, random).move;
}

/* -------------------------------- plantel -------------------------------- */

export const BOTS = Object.freeze([
  {
    id: 'pepito-migas', name: 'Pepito Migas', elo: 250, title: null,
    country: 'ES', emoji: '🍪', style: 'caotico', book: 'none',
    avatar: { bg: '#f4a261', fg: '#3d2b1f', face: 'mofletes-redondos' },
    tagline: 'Juega con una galleta en cada mano',
    bio: 'Tiene seis años y aprendió mirando a su hermano mayor. Mueve la pieza que le pilla más cerca y deja migas en el tablero. Si pierde, pide otra partida y otra galleta.',
    weights: { pst: 0.3, aggression: 1.6, materialism: 0.6, centerControl: 0.4 },
    strength: {},
    favoriteOpenings: ['Apertura del peón de torre', 'Defensa Escandinava'],
    lines: {
      greeting: [
        '¡Hola! ¿Tú también tienes galletas o solo yo?',
        'Voy con las blancas... ¿o con las negras? Bueno, con estas.',
        'Mi hermano dice que soy malo, pero él perdió ayer contra la abuela.',
        'Empiezo yo, que ya tengo la mano levantada.',
      ],
      win: [
        '¡Gané! Voy a contárselo a todo el mundo, empezando por el perro.',
        '¿Has visto? ¡He ganado sin que nadie me ayudara!',
        'Me toca elegir la merienda, son las normas.',
        '¡Bien, bien, bien! Otra vez, otra vez.',
      ],
      lose: [
        'Jo. Es que me estaba acordando de otra cosa.',
        'Has ganado porque tienes más años que yo.',
        'No pasa nada, el juego es largo y yo soy pequeño.',
        'Me la guardo. La próxima te como esa reina.',
      ],
      draw: [
        '¿Empate es que hemos ganado los dos? Pues vale.',
        'Nadie llora entonces. Mejor.',
        'Ha quedado igualito, como cuando partimos la galleta.',
        'Mi hermano dice que los empates no cuentan. Yo digo que sí.',
      ],
      blunder: [
        '¡Ay! Esa pieza se ha movido sola, te lo juro.',
        'No mires. No mires. Ya está, ya pasó.',
        'Yo quería ponerla en la otra casilla, la de al lado.',
        'Bueno, era mi pieza menos favorita igualmente.',
      ],
      check: [
        '¡Jaque! Eso significa que corras, ¿verdad?',
        'Tu rey está en apuros y yo estoy muy contento.',
        '¡Jaque, jaque! Lo digo dos veces para que se note.',
        'Mira tu rey, mira lo que le he hecho.',
      ],
      brilliant: [
        '¿Eso lo he hecho yo? ¡Que alguien lo apunte!',
        'Creo que acabo de hacer algo muy listo.',
        'Ha salido justo como en mi cabeza, ¡y eso no pasa nunca!',
        'Se lo voy a enseñar mañana a mi profe.',
      ],
      thinking: [
        'A ver, a ver...',
        'Esta pieza va así, ¿no?',
        'Espera que cuento las casillas.',
        'Mmm, la de arriba o la de abajo.',
      ],
    },
  },
  {
    id: 'luli-caballitos', name: 'Luli Ferreyra', elo: 400, title: null,
    country: 'UY', emoji: '🐴', style: 'caotico', book: 'none',
    avatar: { bg: '#7ec8a9', fg: '#1b3a2b', face: 'trenzas' },
    tagline: 'Los caballos son sus amigos, el resto le da igual',
    bio: 'Nueve años y una colección entera de figuritas de caballos. Saca los dos a pasear en las primeras jugadas y les pone nombre. Cuando le comen uno, se queda callada un rato largo.',
    weights: { mobility: 1.4, pst: 0.6, aggression: 1.3, materialism: 0.8 },
    strength: {},
    favoriteOpenings: ['Defensa de los dos caballos', 'Apertura Vienesa'],
    lines: {
      greeting: [
        'Este caballo se llama Trueno y ese otro Galleta.',
        '¿Sabías que el caballo salta por encima de todos? Es el mejor.',
        'Hola, voy a jugar con los caballos primero, siempre.',
        'Prometo no saltar arriba de la mesa. Solo en el tablero.',
      ],
      win: [
        '¡Trueno y Galleta hicieron todo el trabajo!',
        'Gané y ni siquiera moví las torres.',
        'Voy a dibujar esta partida en el cuaderno.',
        'Te lo dije: los caballos siempre ganan.',
      ],
      lose: [
        'Se me cansaron los caballos, eso fue.',
        'Está bien, jugaste lindo, pero yo jugué más lindo.',
        'La próxima traigo los dos caballos y también la yegua.',
        'Ya sé qué hice mal: dejé de mirar el tablero.',
      ],
      draw: [
        'Empate. Trueno dice que está conforme.',
        'Nadie perdió, así que nadie tiene que abrazar a nadie.',
        'Quedamos iguales, como en la carrera del recreo.',
        'Bueno, mañana desempatamos.',
      ],
      blunder: [
        '¡No, ahí no, Galleta! ¡Ahí no!',
        'Ese caballo saltó donde no era, se distrajo.',
        'Uy. Hago como que no lo vi y sigo.',
        'Eso me pasa por pensar en el recreo.',
      ],
      check: [
        '¡Jaque con caballo, el más bonito de todos!',
        'Tu rey está rodeado, mejor que se mude.',
        '¡Saltó y llegó! ¿Viste cómo saltó?',
        'Jaque. Corré, corré, corré.',
      ],
      brilliant: [
        '¡Doble ataque! Eso lo aprendí en la escuela.',
        'El caballo hizo una pirueta y salió perfecta.',
        'Esto va derechito al cuaderno de las jugadas lindas.',
        'Nadie me enseñó eso, me salió solo.',
      ],
      thinking: [
        '¿Y si salto por acá?',
        'Caballito, ¿dónde querés ir?',
        'Dejame contar los saltos.',
        'Una casilla, dos, y la vuelta.',
      ],
    },
  },
  {
    id: 'don-ruperto', name: 'Don Ruperto Vega', elo: 550, title: null,
    country: 'MX', emoji: '🚕', style: 'materialista', book: 'none',
    avatar: { bg: '#e9c46a', fg: '#2b2b2b', face: 'bigote-espeso' },
    tagline: 'Cuarenta años de taxi y ni un peón regalado',
    bio: 'Manejó taxi cuarenta años en la ciudad y aprendió a contar el cambio sin mirar. Ahora cuenta peones igual: uno por uno, en voz alta, y no le perdona ninguno a nadie.',
    weights: { materialism: 1.8, material: 1.4, aggression: 0.5, development: 0.7 },
    strength: {},
    favoriteOpenings: ['Defensa Francesa', 'Apertura Española'],
    lines: {
      greeting: [
        'Buenas. Vamos despacio, que el apuro es de los jóvenes.',
        'Le aviso desde ahorita: aquí no se regala nada.',
        'Siéntese, acomódese. Esto va para largo.',
        'Cuarenta años manejando me enseñaron a no adelantarme.',
      ],
      win: [
        'Gané contando, que es como se gana todo en esta vida.',
        'Un peoncito de más y ahí está la diferencia.',
        'No hice nada del otro mundo, solo no perder nada.',
        'Le guardo el asiento para la revancha.',
      ],
      lose: [
        'Me distraje con el peón equivocado. Cosas de la edad.',
        'Usted jugó mejor y yo no se lo voy a discutir.',
        'Perdí, pero perdí barato. Ya vendrá lo mío.',
        'Ya me sé el camino de vuelta, no se preocupe.',
      ],
      draw: [
        'Tablas. Ni usted me debe ni yo le debo.',
        'Quedamos a mano, como con el chofer del otro turno.',
        'Un empate honrado también se cobra.',
        'Está bien así, nadie salió raspado.',
      ],
      blunder: [
        'Ay, esa pieza la solté antes de pensarla.',
        'Se me fue el número. Me pasa cuando hablo y juego.',
        'Perdí una pieza, no la cabeza. Sigo contando.',
        'Ni modo. A recuperar poquito a poquito.',
      ],
      check: [
        'Jaque, y le cobro el viaje completo.',
        'Su rey anda sin cinturón, ahí le encargo.',
        'Se le cruzó una torre, ¿la vio venir?',
        'Jaque. Se me hace que hay que mover a ese señor.',
      ],
      brilliant: [
        'Mire nomás qué bonito quedó ese cambio.',
        'Esa la vi hace tres jugadas y me la guardé.',
        'Todo cuadra: piezas, casillas y cuentas.',
        'Hasta yo me sorprendí, se lo confieso.',
      ],
      thinking: [
        'Déjeme contar otra vez.',
        'A ver qué me cuesta esto...',
        'Uno, dos, tres piezas suyas.',
        'Hay que ir sin prisa por esta calle.',
      ],
    },
  },
  {
    id: 'sarita-libreta', name: 'Sarita Otálora', elo: 700, title: null,
    country: 'CO', emoji: '🔢', style: 'solido', book: 'wide',
    avatar: { bg: '#ef476f', fg: '#fff3f6', face: 'flequillo-recto' },
    tagline: 'Cuenta cada jugada en voz alta, sin excepción',
    bio: 'Tiene trece años, es delegada de curso y apunta todo en una libreta de tapas rojas. Dice los números en voz alta porque así, jura, no se le escapa ninguna pieza.',
    weights: { pawnStructure: 1.3, kingSafety: 1.3, aggression: 0.6 },
    strength: {},
    favoriteOpenings: ['Defensa Eslava', 'Gambito de Dama Rehusado'],
    lines: {
      greeting: [
        'Buenas, ya tengo la libreta abierta en la página siguiente.',
        'Voy a ir diciendo las jugadas, avíseme si le molesta.',
        'Jugada número uno de muchas, empecemos.',
        'Le advierto que anoto todo, hasta lo que le sale mal.',
      ],
      win: [
        'Cuarenta y dos jugadas. Lo escribí y lo subrayé.',
        'Gané sin regalar ni una pieza, eso es lo que me gusta.',
        'Esto va a la libreta con estrellita.',
        'Ordenadito y sin sustos, así se hace.',
      ],
      lose: [
        'Perdí en la jugada treinta y uno, ya la tengo marcada.',
        'Voy a estudiar esto esta noche, no me queda otra.',
        'Me ganó bien, no hay nada que reclamar.',
        'Anoto la derrota y sigo, que para eso está la libreta.',
      ],
      draw: [
        'Empate, ya lo anoté con su medio punto y todo.',
        'Ni ganar ni perder, pero aprendí tres cosas.',
        'Quedamos iguales y la libreta lo confirma.',
        'Un empate bien defendido vale casi como una victoria.',
      ],
      blunder: [
        'Ay no, y justo cuando iba contando bien.',
        'Se me fue un número y detrás se me fue la pieza.',
        'Eso no lo voy a anotar. Bueno, sí, pero chiquito.',
        'Falló la cuenta, no la idea. Eso lo arreglo.',
      ],
      check: [
        'Jaque. Una, dos casillas para su rey, nada más.',
        'Cuento las salidas que le quedan: son poquitas.',
        'Jaque, y esto también queda por escrito.',
        'Su rey tiene problemas y yo tengo lápiz.',
      ],
      brilliant: [
        '¡Estrella grande en la libreta para esta jugada!',
        'Salió exactamente como la conté, casilla por casilla.',
        'Esta se la enseño mañana a todo el salón.',
        'Tres jugadas seguidas sin equivocarme en la cuenta.',
      ],
      thinking: [
        'Uno, dos, tres, cuatro...',
        'A ver, cuento otra vez desde el principio.',
        'Si voy aquí, él va allá.',
        'Espere que apunto la idea.',
      ],
    },
  },
  {
    id: 'nando-brasas', name: 'Nando Quispe', elo: 850, title: null,
    country: 'PE', emoji: '🔥', style: 'agresivo', book: 'sharp',
    avatar: { bg: '#d94f30', fg: '#fff0e2', face: 'gorro-cocina' },
    tagline: 'Ataca como quien aviva las brasas',
    bio: 'Cocina a las brasas desde los quince y juega igual: fuego alto, todo al centro y a ver quién aguanta el humo. Dice que una partida sin sacrificio le sabe sosa.',
    weights: { aggression: 1.7, kingSafety: 0.6, materialism: 0.6, development: 1.3 },
    strength: {},
    favoriteOpenings: ['Gambito Evans', 'Ataque Indio de Rey'],
    lines: {
      greeting: [
        'Ya prendí el carbón, usted avise cuando esté listo.',
        'Aquí se juega caliente o no se juega.',
        'Le voy a servir el ataque bien servido, sin cubiertos.',
        'Vamos a hacer humo en ese tablero.',
      ],
      win: [
        'Quedó en su punto. Ni un minuto de más.',
        'Se lo dije: fuego alto y todo se rinde.',
        'Ataqué hasta que algo cedió, siempre cede algo.',
        'Buena partida, y me quedé con hambre de otra.',
      ],
      lose: [
        'Me pasé de fuego y se me quemó por dentro.',
        'Usted aguantó el calor mejor que yo, lo reconozco.',
        'Ataqué mal, no ataqué poco. Esa es mi falla.',
        'La próxima bajo un poquito la llama.',
      ],
      draw: [
        'Empate, y eso que casi le prendo el rey.',
        'Nos quedamos los dos sin leña al mismo tiempo.',
        'Ni frío ni quemado. Rarísimo en mí.',
        'Tablas, pero yo me llevo el olor a pólvora.',
      ],
      blunder: [
        '¡Se me fue la mano con la sal en esa!',
        'Colgué una pieza por mirar el ataque y no el tablero.',
        'Eso fue feo, pero yo no me apago por una pieza.',
        'Bueno, ahora ataco con una menos. Más mérito.',
      ],
      check: [
        '¡Jaque! Y esto recién se está calentando.',
        'Su rey está sobre las brasas, hermano.',
        'Jaque, muévalo rápido que se le pasa.',
        'Ahí va la primera llamarada.',
      ],
      brilliant: [
        '¡Esa combinación quedó jugosa!',
        'Sacrifiqué y salió exactamente al punto.',
        'Cuando sale así, hasta yo aplaudo.',
        'Eso no se enseña, eso se cocina con los años.',
      ],
      thinking: [
        '¿Qué sacrifico por acá?',
        'Huele a ataque, déjeme ver.',
        'Aguante que estoy midiendo el fuego.',
        'Si empujo este peón, algo revienta.',
      ],
    },
  },
  {
    id: 'marga-refranes', name: 'Marga Bermúdez', elo: 1000, title: null,
    country: 'ES', emoji: '✂️', style: 'solido', book: 'solid',
    avatar: { bg: '#b07bac', fg: '#fdf6ff', face: 'mono-alto' },
    tagline: 'Un refrán por jugada, y no cobra de más',
    bio: 'Lleva treinta años cortando el pelo del barrio y escuchando historias ajenas. Juega despacito, como quien iguala las puntas, y suelta un refrán cada vez que le toca mover.',
    weights: { pawnStructure: 1.4, kingSafety: 1.2, aggression: 0.6, development: 1.2 },
    strength: {},
    favoriteOpenings: ['Sistema Colle', 'Defensa Caro-Kann'],
    lines: {
      greeting: [
        'Siéntate, que quien espera lo suyo alcanza.',
        'Hola, guapo. ¿Te lo corto muy corto o jugamos tranquilos?',
        'Vamos allá, que el que mucho corre pronto para.',
        'Aquí se juega como se peina: con paciencia.',
      ],
      win: [
        'Ya te lo decía yo: quien guarda, halla.',
        'Sin prisas y sin tijeretazos, así se gana.',
        'Poquito a poco se hace el peinado y la partida.',
        'Me llevo el punto y también la conversación.',
      ],
      lose: [
        'Quien juega con fuego a veces se chamusca. Me tocó.',
        'Bien hecho, bonito, esta te la has ganado.',
        'No hay mal peinado que cien años dure.',
        'Me has cortado por donde más dolía, enhorabuena.',
      ],
      draw: [
        'Tablas, que ni tanto ni tan calvo.',
        'Dos puntas igualadas, ha quedado parejo.',
        'Ni tú ni yo, y así también se descansa.',
        'Tablas y tan amigas, hija mía.',
      ],
      blunder: [
        'Huy, se me ha ido la mano con la tijera.',
        'Eso ha sido un tijeretazo de más, lo reconozco.',
        'Al mejor peluquero se le escapa un mechón.',
        'Ya está hecho. Se disimula y para adelante.',
      ],
      check: [
        'Jaque, majo, que te toca moverte.',
        'Tu rey anda despeinado y con prisa.',
        'Jaque. Y esto no es capricho, es ley.',
        'Mira cómo se te ha quedado el rey ahí sentadito.',
      ],
      brilliant: [
        'Ay, qué jugada más bien rematada.',
        'Esa ha quedado como un peinado de boda.',
        'Y encima me ha salido sin despeinarme.',
        'Cuando cuadra así, da gustito.',
      ],
      thinking: [
        'Déjame que lo mire con calma.',
        'Un momentito, que estoy midiendo.',
        'Vamos a pensarlo como Dios manda.',
        'Aquí hay algo, lo huelo.',
      ],
    },
  },
  {
    id: 'ivo-socorrista', name: 'Ivo Mandić', elo: 1150, title: null,
    country: 'HR', emoji: '🛟', style: 'posicional', book: 'solid',
    avatar: { bg: '#2a9d8f', fg: '#f1faee', face: 'nariz-quemada' },
    tagline: 'Vigila el tablero como vigila la orilla',
    bio: 'Pasa el verano subido a una silla mirando el mar y el invierno mirando tableros. Dice que las dos cosas son iguales: no ocurre nada durante horas y luego ocurre todo de golpe.',
    weights: { pst: 1.3, kingSafety: 1.4, centerControl: 1.2, aggression: 0.7 },
    strength: {},
    favoriteOpenings: ['Defensa India de Rey', 'Apertura Inglesa'],
    lines: {
      greeting: [
        'Buenas. Yo miro mucho y muevo poco, ya lo verás.',
        'Antes de entrar al agua conviene mirar la corriente.',
        'Hola. Tengo todo el turno por delante, así que sin apuro.',
        'Que conste que nunca me duermo en la silla.',
      ],
      win: [
        'Esperé a que te metieras demasiado adentro.',
        'Nada espectacular: solo estar en el sitio correcto.',
        'La corriente te llevó y yo solo miré cómo.',
        'Gané sin mojarme los pies. Como debe ser.',
      ],
      lose: [
        'Me confié con el oleaje y me pasó por encima.',
        'Buen trabajo. Esta vez el ahogado fui yo.',
        'Miré a la izquierda y el peligro venía por la derecha.',
        'Toca secarse y volver a subir a la silla.',
      ],
      draw: [
        'Marea igualada, nadie llega a la boya.',
        'Tablas. Los dos nadamos lo justo.',
        'Un empate tranquilo, de esos de agosto sin viento.',
        'Ninguno se metió donde no debía. Bien.',
      ],
      blunder: [
        'Ahí perdí de vista una pieza. Se me escapó del agua.',
        'Vaya despiste, y eso que mi trabajo es no despistarme.',
        'Bueno. Se rescata lo que se pueda y seguimos.',
        'Me he metido solo en la corriente, nadie me empujó.',
      ],
      check: [
        'Jaque. Tu rey está muy lejos de la orilla.',
        'Pitido largo: sal de ahí ahora mismo.',
        'Jaque, y esa casilla tampoco es segura.',
        'Te has salido de la zona con bandera verde.',
      ],
      brilliant: [
        'Llevaba diez jugadas viendo venir esta ola.',
        'Ahí todo encajó, y yo sin moverme de la silla.',
        'Eso es paciencia, no talento. Te lo aseguro.',
        'Un rescate limpio, sin salpicar a nadie.',
      ],
      thinking: [
        'Miro la corriente primero.',
        'Aún no toca moverse.',
        'Espero, espero, espero.',
        '¿Dónde está el peligro ahora?',
      ],
    },
  },
  {
    id: 'kenji-afinador', name: 'Kenji Arakaki', elo: 1300, title: null,
    country: 'JP', emoji: '🎹', style: 'tecnico', book: 'solid',
    avatar: { bg: '#3d405b', fg: '#f4f1de', face: 'gafas-finas' },
    tagline: 'Afina la posición hasta que deja de desafinar',
    bio: 'Afina pianos desde hace veinte años y asegura que una posición mal llevada suena parecido a una cuerda floja. Juega buscando el momento exacto en que el tablero se pone recto.',
    weights: { pawnStructure: 1.4, pst: 1.2, mobility: 1.2, aggression: 0.7 },
    strength: {},
    favoriteOpenings: ['Apertura Reti', 'Defensa Nimzoindia'],
    lines: {
      greeting: [
        'Buenas tardes. Empecemos por comprobar el tono.',
        'Cada partida tiene su afinación propia. Busquemos la nuestra.',
        'Hola. Prefiero corregir pequeño y a menudo.',
        'Si algo suena mal en el tablero, lo oigo antes de verlo.',
      ],
      win: [
        'Al final todo quedó en su tono. Nada más.',
        'No hubo golpes, solo ajustes muy pequeños.',
        'Su posición desafinó primero, y eso decidió todo.',
        'Gracias por la partida. Ha sonado limpia.',
      ],
      lose: [
        'Me equivoqué de cuerda y tiré de la que no era.',
        'Usted afinó mejor. Lo acepto sin hacer ruido.',
        'Escuché el error tarde, cuando ya estaba dentro.',
        'Volveré con el oído más despierto.',
      ],
      draw: [
        'Dos instrumentos en el mismo tono exacto.',
        'Tablas limpias, sin una sola nota fea.',
        'No hay nada que corregir en este resultado.',
        'Empate: la posición nunca llegó a torcerse.',
      ],
      blunder: [
        'He apretado la clavija de más. Culpa mía.',
        'Un golpe seco donde hacía falta delicadeza.',
        'Se me rompió la cuerda. Se cambia y se sigue.',
        'Error de pulso. No de idea, de pulso.',
      ],
      check: [
        'Jaque. Esa nota no la esperaba, ¿verdad?',
        'Su rey ha quedado medio tono desafinado.',
        'Jaque; conviene responder con precisión.',
        'Ahí el tablero ha sonado muy agudo.',
      ],
      brilliant: [
        'Perfecto. Ni un armónico fuera de lugar.',
        'Llevaba rato buscando esa nota exacta.',
        'Cuando cuadra así, el tablero suena solo.',
        'Ese detalle valía toda la tarde de trabajo.',
      ],
      thinking: [
        'Escucho la posición.',
        'Medio tono más arriba, quizá.',
        'Algo aquí vibra raro.',
        'Con calma, con calma.',
      ],
    },
  },
  {
    id: 'bea-mareas', name: 'Bea Ontiveros', elo: 1400, title: null,
    country: 'CL', emoji: '🐙', style: 'posicional', book: 'wide',
    avatar: { bg: '#457b9d', fg: '#fdfcdc', face: 'pelo-rizado' },
    tagline: 'Estudia la posición como si fuera un arrecife',
    bio: 'Se pasa media vida en un barco contando pulpos y la otra media mirando tableros en el camarote. Habla de las piezas como de bichos: dice que cada una tiene su hábitat favorito.',
    weights: { mobility: 1.4, pst: 1.3, centerControl: 1.2, bishopPair: 1.2 },
    strength: {},
    favoriteOpenings: ['Defensa Grünfeld', 'Apertura Catalana'],
    lines: {
      greeting: [
        'Hola. Voy a observar un rato antes de tocar nada.',
        'Cada pieza tiene su hábitat, hay que ubicarlas bien.',
        'Partida nueva, muestra nueva. Me encanta esta parte.',
        'Traigo el cuaderno de campo, aviso.',
      ],
      win: [
        'Los alfiles encontraron su corriente y se fueron solos.',
        'Colonicé el centro y después solo hubo que esperar.',
        'Gané por especialización: cada pieza en su sitio.',
        'Buen ejemplar de partida, me la quedo.',
      ],
      lose: [
        'Mis piezas quedaron varadas en la arena. Culpa mía.',
        'Observé demasiado y actué demasiado poco.',
        'Enhorabuena, me leíste el plan entero.',
        'Toca revisar los datos y repetir el experimento.',
      ],
      draw: [
        'Ecosistema equilibrado. Nadie se comió a nadie.',
        'Tablas: dos especies que conviven sin molestarse.',
        'Se estabilizó y ninguna de las dos cedió terreno.',
        'Un empate de esos que da gusto anotar.',
      ],
      blunder: [
        'Uy, dejé una pieza expuesta en aguas abiertas.',
        'Eso fue mirar el microscopio y olvidar el mar.',
        'Fallo de muestreo. Pasa hasta en los buenos estudios.',
        'Bueno, el arrecife aguanta una pérdida.',
      ],
      check: [
        'Jaque. Tu rey salió del escondite.',
        'Sin refugio no se sobrevive, y el tuyo no tiene.',
        'Jaque, y la salida de ahí es estrechísima.',
        'Te quedaste sin roca donde meterte.',
      ],
      brilliant: [
        'Esa maniobra la llevaba observando diez jugadas.',
        'El caballo llegó justo a su casilla natural.',
        'Precioso. Digno de portada de revista.',
        'Cuando la estructura acompaña, todo fluye.',
      ],
      thinking: [
        'Observo la estructura.',
        '¿Qué pieza está incómoda?',
        'Anoto y calculo.',
        'Aquí hay una casilla débil.',
      ],
    },
  },
  {
    id: 'fito-madrugada', name: 'Fito Barrantes', elo: 1500, title: null,
    country: 'CR', emoji: '📻', style: 'tactico', book: 'wide',
    avatar: { bg: '#264653', fg: '#e9d8a6', face: 'auriculares-grandes' },
    tagline: 'Habla bajito y ataca a las tres de la mañana',
    bio: 'Presenta el programa de madrugada desde hace doce años y juega entre canción y canción. Dice que a esa hora la gente llama para confesarse y las piezas también bajan la guardia.',
    weights: { aggression: 1.3, mobility: 1.3, kingSafety: 0.8 },
    strength: {},
    favoriteOpenings: ['Defensa Siciliana', 'Ataque Grand Prix'],
    lines: {
      greeting: [
        'Buenas noches a quien esté despierto. Empezamos.',
        'Bajen el volumen, que esta partida pide concentración.',
        'Tenemos tablero, tenemos café y tenemos toda la madrugada.',
        'Aviso: yo despierto justo cuando los demás se duermen.',
      ],
      win: [
        'Y así cerramos la emisión de hoy, queridos oyentes.',
        'Gané en la parte de la noche donde nadie mira.',
        'Dedicada a los que trabajan de madrugada.',
        'Suena la última canción y me la llevo yo.',
      ],
      lose: [
        'Me dormí en el turno, cosa fea en mi oficio.',
        'Buena jugada. Esta va sin música de fondo.',
        'Perdí el hilo entre una llamada y otra.',
        'Mañana lo cuento en el programa, sin adornar nada.',
      ],
      draw: [
        'Tablas. Ni tú cortas ni yo corto la transmisión.',
        'Empatamos y todavía queda noche por delante.',
        'Se acabó la cinta justo por la mitad.',
        'Un empate de esos que se escuchan bien.',
      ],
      blunder: [
        'Ese fue un silencio en el aire, de los que se notan.',
        'Metí la pata con el micrófono abierto, además.',
        'Ay, ay, ay. Corto y sigo como si nada.',
        'Una pieza menos. La noche es larga, se recupera.',
      ],
      check: [
        'Jaque, y esto sí va en directo.',
        'Su majestad tiene una llamada urgente.',
        'Jaque. Suba el volumen, que viene lo bueno.',
        'Ese rey no tiene dónde esconderse a esta hora.',
      ],
      brilliant: [
        '¡Eso merece una cortina musical!',
        'Salió redonda, como un programa bien montado.',
        'Tres jugadas encadenadas y sin respirar.',
        'Esta se la voy a contar a los oyentes mañana.',
      ],
      thinking: [
        'Déjenme calcular en el corte.',
        'Hay algo aquí, lo presiento.',
        'Un segundito de silencio.',
        'Si muevo esto, suena todo.',
      ],
    },
  },
  {
    id: 'nour-panadera', name: 'Nour El Fassi', elo: 1600, title: null,
    country: 'MA', emoji: '🥖', style: 'solido', book: 'solid',
    avatar: { bg: '#c98a4b', fg: '#fff8ed', face: 'panuelo-cabeza' },
    tagline: 'Madruga tanto que juega antes que nadie',
    bio: 'Abre el horno a las cuatro de la mañana y a las seis ya ha jugado dos partidas. Sostiene que la masa y la posición piden lo mismo: tiempo, temperatura y no tocarlas de más.',
    weights: { pawnStructure: 1.5, kingSafety: 1.3, development: 1.2, aggression: 0.6 },
    strength: {},
    favoriteOpenings: ['Defensa Berlinesa', 'Apertura de peón de dama'],
    lines: {
      greeting: [
        'Buenos días, aunque para mí ya es media mañana.',
        'La masa está reposando, así que tengo un rato libre.',
        'Empezamos suave, que el horno todavía no está fuerte.',
        'Yo a esta hora ya he trabajado cuatro horas, tenlo en cuenta.',
      ],
      win: [
        'Subió despacio y salió perfecta, como el pan del jueves.',
        'Gané por temperatura constante, sin sobresaltos.',
        'No toqué la posición más de lo necesario. Ese es el truco.',
        'Ya está horneada. Que aproveche.',
      ],
      lose: [
        'Se me pasó de horno y se quemó por abajo.',
        'Jugaste mejor y no hay harina que lo arregle.',
        'Me quedó la masa cruda en el centro. Error mío.',
        'Mañana amaso otra vez, que para eso madrugo.',
      ],
      draw: [
        'Tablas. Dos panes iguales del mismo horno.',
        'Ni cruda ni quemada: justo en el punto.',
        'Empate, y la verdad es que estaba merecido.',
        'Se reparte el pan y no sobra nada.',
      ],
      blunder: [
        'Vaya, se me ha caído la bandeja entera.',
        'Eso ha sido levantarme a las cuatro, seguro.',
        'Se me fue una pieza por ir con prisa. Odio la prisa.',
        'Bueno. Con lo que queda todavía se hace pan.',
      ],
      check: [
        'Jaque. Tu rey huele a quemado.',
        'Ese rey no tiene dónde reposar.',
        'Jaque, y el horno está a tope.',
        'Se te ha quedado el rey en la puerta del horno.',
      ],
      brilliant: [
        'Ha salido dorada por los dos lados.',
        'Esa maniobra llevaba fermentando desde la apertura.',
        'Cuando el tiempo acompaña, la jugada sale sola.',
        'Poca harina y mucho oficio. Así se hace.',
      ],
      thinking: [
        'Dejo reposar la idea.',
        '¿Le falta un minuto más?',
        'Ahora la temperatura justa.',
        'Amaso otra variante.',
      ],
    },
  },
  {
    id: 'wanda-bombilla', name: 'Wanda Kozłowska', elo: 1700, title: null,
    country: 'PL', emoji: '🐈', style: 'tactico', book: 'wide',
    avatar: { bg: '#6d597a', fg: '#ffe8d6', face: 'coleta-baja' },
    tagline: 'Su gato Bombilla opina de cada jugada',
    bio: 'Veterinaria de pueblo, trabaja con vacas por la mañana y con gatos por la tarde. Juega con Bombilla sentado encima del tablero y consulta con él todas las decisiones difíciles.',
    weights: { aggression: 1.3, mobility: 1.4, materialism: 0.9, kingSafety: 0.9 },
    strength: {},
    favoriteOpenings: ['Ataque Trompowsky', 'Defensa Holandesa'],
    lines: {
      greeting: [
        'Hola. Si ves una pata en la pantalla, es Bombilla.',
        'Aviso: el gato ya ha movido una pieza y no pienso corregirla.',
        'Buenas. Vengo de operar a un perro salchicha, estoy fina.',
        'Empezamos, que Bombilla tiene sueño y quiere el tablero.',
      ],
      win: [
        'Bombilla dice que él eligió la última jugada.',
        'Gané, y eso que llevo doce horas de guardia.',
        'Diagnóstico confirmado: tu posición estaba enferma.',
        'Buena partida. Le doy un premio al gato.',
      ],
      lose: [
        'Me equivoqué de tratamiento y el paciente era yo.',
        'Muy bien jugado. Hoy me tocó ser el perro salchicha.',
        'Perdí por culpa mía y de nadie con bigotes.',
        'Bombilla está decepcionado, se ha ido a dormir.',
      ],
      draw: [
        'Tablas. El paciente sale caminando por su propio pie.',
        'Empate: dos organismos igual de sanos.',
        'Nadie ha necesitado puntos de sutura hoy.',
        'Bombilla aprueba el empate, le gusta la calma.',
      ],
      blunder: [
        'Eso ha sido el gato. Vale, no ha sido el gato.',
        'Solté la pieza como quien suelta una jeringuilla llena.',
        'Fallo de pulso. En el quirófano no me pasa, lo juro.',
        'Una pieza menos. Tampoco es una hemorragia.',
      ],
      check: [
        'Jaque. Tu rey necesita revisión urgente.',
        'Ese monarca tiene fiebre y tú lo sabes.',
        'Jaque, y no hay veterinaria que lo salve.',
        'Le he encontrado el punto débil al bicho.',
      ],
      brilliant: [
        '¡Operación limpia, sin una gota de más!',
        'Esa combinación la vi mientras vacunaba terneros.',
        'Hasta Bombilla ha levantado la cabeza.',
        'Precisión de bisturí, si me permites el orgullo.',
      ],
      thinking: [
        'Quita la pata, Bombilla.',
        'Hay táctica aquí, la huelo.',
        'Calculo dos líneas más.',
        '¿Y si clavo el caballo?',
      ],
    },
  },
  {
    id: 'ekene-arbitro', name: 'Ekene Obi', elo: 1800, title: null,
    country: 'NG', emoji: '🟨', style: 'tecnico', book: 'solid',
    avatar: { bg: '#1d3557', fg: '#f7e733', face: 'silbato-al-cuello' },
    tagline: 'Aplica el reglamento hasta en el descanso',
    bio: 'Arbitra ligas regionales los fines de semana y no soporta el desorden. En el tablero busca lo mismo que en el campo: que cada pieza esté donde le toca y que nadie se salte su turno.',
    weights: { pst: 1.3, pawnStructure: 1.3, rookFiles: 1.3, aggression: 0.8 },
    strength: {},
    favoriteOpenings: ['Apertura Inglesa, variante simétrica', 'Defensa Petrov'],
    lines: {
      greeting: [
        'Buenas. Noventa minutos y lo que haga falta añadir.',
        'Aquí las reglas se respetan desde la primera jugada.',
        'Saludo, estrecho la mano y empezamos formalmente.',
        'Le pido juego limpio; yo pienso dárselo.',
      ],
      win: [
        'Partido controlado de principio a fin. Sin tarjetas.',
        'Gané porque nunca perdí la posición del balón.',
        'Se acabó el tiempo reglamentario y el marcador es mío.',
        'Buen encuentro. Deportividad ante todo.',
      ],
      lose: [
        'Me superó y no hay protesta que valga.',
        'Vi la falta tarde. Eso en mi oficio se paga.',
        'Derrota clara, sin polémica arbitral posible.',
        'Le felicito de verdad. Estuvo por encima.',
      ],
      draw: [
        'Reparto de puntos, y muy justo por cierto.',
        'Tablas: ninguno de los dos mereció perder.',
        'Cero a cero y el público se va tranquilo.',
        'Empate correcto, señalado y firmado.',
      ],
      blunder: [
        'Error mío, y de los que se ven desde la grada.',
        'Me expulso yo solo por esa jugada.',
        'Ahí perdí la posición y la compostura a la vez.',
        'Anotado en el acta. Sigo jugando igual.',
      ],
      check: [
        'Jaque. Su rey acumula amonestaciones.',
        'Eso es falta directa sobre el monarca.',
        'Jaque, y no hay ventaja que aplicar.',
        'Su portería está descubierta, se lo aviso.',
      ],
      brilliant: [
        'Jugada de manual, capítulo de finales.',
        'Todo colocado, todo medido, todo reglamentario.',
        'Esa la preparé con seis jugadas de antelación.',
        'Perfecta ejecución. Hasta yo me la aplaudo.',
      ],
      thinking: [
        'Reviso la posición completa.',
        'Un momento, estoy midiendo distancias.',
        'Aquí hay que ser exacto.',
        'Compruebo si esto es legal y bueno.',
      ],
    },
  },
  {
    id: 'martina-ruta', name: 'Martina Sosa', elo: 1900, title: null,
    country: 'AR', emoji: '🚛', style: 'agresivo', book: 'sharp',
    avatar: { bg: '#8d5524', fg: '#ffe9c9', face: 'gorra-visera' },
    tagline: 'Acelera en la apertura y no levanta el pie',
    bio: 'Hace la ruta entre el norte y el puerto dos veces por semana y juega en las paradas de descanso. Le gustan las partidas rectas, largas y a fondo, igual que los tramos de autopista.',
    weights: { aggression: 1.6, development: 1.4, kingSafety: 0.7, passedPawns: 1.3 },
    strength: {},
    favoriteOpenings: ['Gambito de Rey', 'Ataque Yugoslavo'],
    lines: {
      greeting: [
        'Arranco yo, que llevo el motor caliente desde ayer.',
        'Buenas. Tengo cuatro horas de ruta y ganas de jugar.',
        'Avisá si te mareás, porque no pienso frenar.',
        'Subite, que esto va directo y sin desvíos.',
      ],
      win: [
        'Llegué antes y con el tanque todavía por la mitad.',
        'Pisé el acelerador en la apertura y no lo solté más.',
        'Ruta hecha, carga entregada, partida ganada.',
        'Buena pelea. Nos cruzamos de nuevo en la próxima.',
      ],
      lose: [
        'Me pasé de velocidad en una curva cerrada.',
        'Jugaste bien, me dejaste sin combustible.',
        'Ataqué de más y llegué tarde a todos lados.',
        'Me voy con la carga rota, pero vuelvo.',
      ],
      draw: [
        'Empate. Los dos camiones llegaron juntos al peaje.',
        'Tablas y a seguir ruta, no me quejo.',
        'Nadie adelantó a nadie en toda la autopista.',
        'Se repartió la carga mitad y mitad.',
      ],
      blunder: [
        'Uh, ahí me comí un pozo enorme.',
        'Colgué una torre por mirar el espejo equivocado.',
        'Eso pasa cuando manejás dieciséis horas seguidas.',
        'Bueno, sigo con una rueda menos. Igual avanzo.',
      ],
      check: [
        'Jaque. Corré, que vengo por atrás con las luces altas.',
        'Ese rey está parado en medio de la ruta.',
        'Jaque, y la banquina tampoco te sirve.',
        'Te toqué bocina tres jugadas antes, che.',
      ],
      brilliant: [
        '¡Eso fue un adelantamiento en subida y con lluvia!',
        'La combinación entera entró como un guante.',
        'Vengo armando esto desde la jugada diez.',
        'Cuando sale así, vale por todo el viaje.',
      ],
      thinking: [
        'Dejame ver el mapa.',
        '¿Por dónde entro?',
        'Meto quinta o freno.',
        'Calculo el sacrificio.',
      ],
    },
  },
  {
    id: 'hugo-relojero', name: 'Hugo Ferreira', elo: 2000, title: 'CM',
    country: 'PT', emoji: '⏱️', style: 'tecnico', book: 'solid',
    avatar: { bg: '#4a4e69', fg: '#f2e9e4', face: 'monoculo' },
    tagline: 'Mide la partida en fracciones de segundo',
    bio: 'Repara relojes antiguos en un taller de tres metros cuadrados, con pinzas diminutas y mucha luz. Sostiene que una ventaja pequeña, como un engranaje, funciona si está perfectamente colocada.',
    weights: { pst: 1.2, passedPawns: 1.3, pawnStructure: 1.3, aggression: 0.8, mobility: 1.2 },
    strength: {},
    favoriteOpenings: ['Apertura Española, variante cerrada', 'Defensa Semieslava'],
    lines: {
      greeting: [
        'Buenas. Tengo la lupa puesta, empecemos.',
        'Las ventajas pequeñas también hacen tictac.',
        'Hola. Trabajo despacio, pero no me tiembla el pulso.',
        'Un engranaje mal puesto arruina el reloj entero.',
      ],
      win: [
        'Todo encajó y el mecanismo empezó a andar solo.',
        'Gané por milímetros acumulados, uno detrás de otro.',
        'Ni una pieza fuera de su eje. Eso ha sido todo.',
        'Ha sido un placer. Su reloj va un poco atrasado.',
      ],
      lose: [
        'Se me salió un muelle y ya no lo recuperé.',
        'Ha jugado usted con una precisión que no igualé.',
        'Un fallo mínimo, pero es que aquí todo es mínimo.',
        'Me llevo la pieza rota al taller y la estudio.',
      ],
      draw: [
        'Dos relojes marcando exactamente la misma hora.',
        'Tablas. El mecanismo quedó equilibrado.',
        'Nada que ajustar: el resultado es correcto.',
        'Empate, y ninguno perdió un segundo por el camino.',
      ],
      blunder: [
        'Ahí se me cayó la pinza encima de la maquinaria.',
        'Un temblor de mano y se estropea la tarde entera.',
        'Imperdonable en mi oficio, aunque muy humano.',
        'Recojo las piezas del suelo y continúo.',
      ],
      check: [
        'Jaque. Su rey va con retraso.',
        'El mecanismo se le ha soltado por ese lado.',
        'Jaque, y el margen que le queda es fino.',
        'Ese monarca necesita una revisión completa.',
      ],
      brilliant: [
        'Encaja como un rubí en su alojamiento.',
        'Diez jugadas montando esto y por fin gira.',
        'Simetría perfecta. Me quedo mirándola un rato.',
        'Ese es el tipo de detalle por el que sigo jugando.',
      ],
      thinking: [
        'Ajusto un poco más.',
        'Tictac, tictac.',
        'Falta medio milímetro.',
        'Compruebo el engranaje.',
      ],
    },
  },
  {
    id: 'zoya-compila', name: 'Zoya Aliyeva', elo: 2100, title: 'CM',
    country: 'AZ', emoji: '🌙', style: 'posicional', book: 'wide',
    avatar: { bg: '#22223b', fg: '#9a8c98', face: 'capucha-subida' },
    tagline: 'Depura posiciones a las dos de la mañana',
    bio: 'Escribe código para una empresa que no le deja contar qué hace y juega mientras compila. Trata cada partida como un error raro: lo reproduce, lo aísla y después lo arregla.',
    weights: { pst: 1.3, mobility: 1.3, centerControl: 1.3, kingSafety: 1.1 },
    strength: {},
    favoriteOpenings: ['Defensa Nimzoindia, variante Rubinstein', 'Apertura Reti con fianchetto'],
    lines: {
      greeting: [
        'Hola. Estoy compilando, así que tengo unos minutos.',
        'Voy a tratar tu plan como un error a reproducir.',
        'Buenas. Trabajo mejor con la luz apagada.',
        'Tablero limpio, cabeza limpia. Adelante.',
      ],
      win: [
        'Encontré el fallo en tu estructura y lo exploté.',
        'Gané sin prisa, línea por línea.',
        'Esto compila. Sin avisos y sin errores.',
        'Buena partida; me llevo un caso interesante.',
      ],
      lose: [
        'Tu jugada rompió mi plan en tiempo de ejecución.',
        'Reconozco la derrota: mi código tenía un agujero.',
        'Lo reproduzco mañana y lo entiendo, te lo prometo.',
        'Bien jugado. No lo vi venir y eso me fastidia.',
      ],
      draw: [
        'Tablas: dos soluciones distintas, mismo resultado.',
        'Empate limpio, sin memoria perdida por el camino.',
        'Ninguna de las dos versiones falló hoy.',
        'Nos quedamos en el mismo punto exacto del programa.',
      ],
      blunder: [
        'Ahí tenía un caso sin cubrir y me estalló.',
        'Error mío, de los que se ven en la primera línea.',
        'Estaba pensando en otra cosa, literalmente en otro archivo.',
        'Anoto el fallo y sigo, que la partida continúa.',
      ],
      check: [
        'Jaque. Tu rey no tiene salida definida.',
        'Ahí se te desborda la defensa.',
        'Jaque, y las casillas de escape son pocas.',
        'Tu monarca acaba de quedarse sin memoria.',
      ],
      brilliant: [
        'Elegante y corta. Así deberían ser todas las soluciones.',
        'Esta maniobra la tenía guardada desde la apertura.',
        'Todo el plan en una sola jugada. Me gusta.',
        'Funciona a la primera y encima es bonita.',
      ],
      thinking: [
        'Compilando idea...',
        'Reviso el caso raro.',
        'Dos ramas más y decido.',
        'Esto huele a error.',
      ],
    },
  },
  {
    id: 'bruno-auditor', name: 'Bruno Cattaneo', elo: 2200, title: 'FM',
    country: 'IT', emoji: '🧾', style: 'materialista', book: 'solid',
    avatar: { bg: '#586f7c', fg: '#f4f4f9', face: 'cejas-pobladas' },
    tagline: 'Audita cada peón como si fuera una factura',
    bio: 'Persigue cuentas falsas en empresas grandes y dice que el ajedrez es lo mismo con menos papeleo. Un peón de ventaja le parece una prueba irrefutable y no la suelta jamás.',
    weights: { materialism: 1.7, material: 1.3, aggression: 0.7, pawnStructure: 1.2, contempt: 10 },
    strength: {},
    favoriteOpenings: ['Gambito de Dama Aceptado', 'Defensa Caro-Kann, variante clásica'],
    lines: {
      greeting: [
        'Buenas. Voy a revisar sus cuentas jugada por jugada.',
        'Le anticipo que un peón para mí es una cifra, no un adorno.',
        'Empecemos. Traigo la calculadora y toda la tarde.',
        'Nada de regalos: aquí todo entra en el balance.',
      ],
      win: [
        'Las cuentas cuadran y el saldo es favorable.',
        'Un peón de ventaja, bien cobrado, gana partidas enteras.',
        'No hubo magia. Hubo contabilidad.',
        'Cierro el ejercicio con superávit. Gracias.',
      ],
      lose: [
        'Se me coló un gasto que no estaba en el libro.',
        'Ha encontrado usted el agujero antes que yo.',
        'Derrota auditada y aceptada sin recurso.',
        'Revisaré el expediente esta noche, como siempre.',
      ],
      draw: [
        'Balance a cero. Ni pérdidas ni ganancias.',
        'Tablas: las dos columnas suman lo mismo.',
        'Un empate perfectamente documentado.',
        'No hay saldo pendiente entre nosotros.',
      ],
      blunder: [
        'Me he equivocado en una cifra y se nota mucho.',
        'Eso es un descuadre grave y lo asumo.',
        'Increíble. Yo, precisamente yo, regalando material.',
        'Apunto la pérdida en rojo y sigo trabajando.',
      ],
      check: [
        'Jaque. Su rey tiene una deuda vencida.',
        'Le reclamo formalmente esa casilla.',
        'Jaque, y el plazo para pagar es de una jugada.',
        'Su monarca figura en la lista de morosos.',
      ],
      brilliant: [
        'Ahí estaba el fraude escondido. Lo he encontrado.',
        'Esta combinación vale exactamente dos peones y medio.',
        'Impecable. Se puede presentar ante un juez.',
        'Llevaba doce jugadas reuniendo esas pruebas.',
      ],
      thinking: [
        'Reviso los números.',
        '¿Cuánto vale esto exactamente?',
        'Sumo, resto y decido.',
        'Aquí falta un asiento.',
      ],
    },
  },
  {
    id: 'indira-observatorio', name: 'Indira Raval', elo: 2350, title: 'FM',
    country: 'IN', emoji: '🔭', style: 'tecnico', book: 'wide',
    avatar: { bg: '#2b2d42', fg: '#edf2f4', face: 'trenza-larga' },
    tagline: 'Paciencia de observatorio, precisión de telescopio',
    bio: 'Trabaja en un observatorio a tres mil metros y está acostumbrada a esperar años por un dato. Juega finales larguísimos sin pestañear y dice que ahí es donde se ve la verdad de cada uno.',
    weights: { passedPawns: 1.4, pawnStructure: 1.3, pst: 1.2, aggression: 0.8, mobility: 1.2 },
    strength: {},
    favoriteOpenings: ['Apertura Catalana cerrada', 'Defensa India de Dama'],
    lines: {
      greeting: [
        'Buenas noches. Arriba está despejado, buena señal.',
        'Le aviso: los finales largos son mi terreno favorito.',
        'Tengo paciencia de sobra, es parte del oficio.',
        'Empezamos. Yo observo antes de concluir nada.',
      ],
      win: [
        'El final estaba escrito desde la jugada veinte.',
        'Gané esperando, que es una forma respetable de ganar.',
        'Un peón lejano decidió todo, como suele pasar.',
        'Gracias por la partida; la anotaré con cuidado.',
      ],
      lose: [
        'Calculé mal la trayectoria y llegué tarde.',
        'Enhorabuena. Ha visto usted algo que yo no vi.',
        'Me falló el final, justo donde presumo de fuerte.',
        'Rehago los cálculos y vuelvo mejor preparada.',
      ],
      draw: [
        'Tablas. Las dos órbitas eran estables.',
        'Empate: ninguna ventaja llegó a ser medible.',
        'El final se cerró sin margen para nadie.',
        'Un resultado honesto con la posición.',
      ],
      blunder: [
        'Un dato mal tomado arruina toda la noche.',
        'He movido antes de terminar de mirar. Torpe.',
        'Ese fallo es mío y no admite atenuantes.',
        'Corrijo el rumbo y sigo observando.',
      ],
      check: [
        'Jaque. Su rey se ha quedado al descubierto.',
        'Ahí no hay atmósfera que lo proteja.',
        'Jaque, y la trayectoria de escape es única.',
        'Su monarca entró en zona sin cobertura.',
      ],
      brilliant: [
        'Ese es el tipo de detalle que solo aparece de madrugada.',
        'Sacrificio calculado hasta la última casilla.',
        'Llevaba quince jugadas preparando ese cambio.',
        'Precioso. Y además es la única jugada que gana.',
      ],
      thinking: [
        'Mido la distancia.',
        'Cuento tiempos de peón.',
        'Un cálculo más y decido.',
        'Todavía no concluyo.',
      ],
    },
  },
  {
    id: 'soren-glaciar', name: 'Søren Dahl', elo: 2500, title: 'IM',
    country: 'DK', emoji: '🧊', style: 'posicional', book: 'solid',
    avatar: { bg: '#a8dadc', fg: '#1d3557', face: 'barba-canosa' },
    tagline: 'Avanza un milímetro por jugada y arrasa',
    bio: 'Estudia el hielo desde hace treinta años y piensa en escalas que no caben en una partida. Aprieta tan despacio que el rival solo se da cuenta cuando ya no le queda sitio donde moverse.',
    weights: { pst: 1.3, pawnStructure: 1.4, mobility: 1.3, aggression: 0.6, contempt: 15 },
    strength: {},
    favoriteOpenings: ['Apertura Inglesa con fianchetto', 'Defensa Eslava, variante principal'],
    lines: {
      greeting: [
        'Buenas. Yo no tengo prisa; el hielo tampoco la tiene.',
        'Vamos a hacer esto lentamente. Muy lentamente.',
        'Hola. Le advierto que sé esperar mejor que casi nadie.',
        'Un glaciar mueve poco al día y aun así parte montañas.',
      ],
      win: [
        'Ha sido presión constante, nada más. Y nada menos.',
        'Gané sin un solo golpe brusco en toda la partida.',
        'Su posición se agrietó sola, yo solo empujaba.',
        'Buena resistencia. Ha durado más de lo previsto.',
      ],
      lose: [
        'Se rompió el frente por donde no lo esperaba.',
        'Mi ritmo fue demasiado lento para esa posición.',
        'Ha jugado usted con una energía que no supe frenar.',
        'Aprendo. A mi edad todavía se aprende.',
      ],
      draw: [
        'Tablas. Dos masas que se empujan y ninguna cede.',
        'Empate: la presión existió, pero nunca fue suficiente.',
        'Quedó todo congelado, y así se queda.',
        'No había manera de romperlo. Lo firmo tranquilo.',
      ],
      blunder: [
        'Una grieta en mi propio terreno. Qué rabia.',
        'He calculado mal el peso y se ha venido abajo.',
        'Ese descuido no encaja con treinta años de oficio.',
        'Sigo empujando, aunque ahora cuesta el doble.',
      ],
      check: [
        'Jaque. El suelo bajo su rey ya no aguanta.',
        'Ahí el terreno cede, se lo dije hace diez jugadas.',
        'Jaque; le quedan pocas casillas firmes.',
        'Su monarca camina sobre hielo fino.',
      ],
      brilliant: [
        'Veinte jugadas de presión cabían en esa sola.',
        'Cuando el hielo se rompe, se rompe entero.',
        'Esa maniobra me ha costado toda la mañana pensarla.',
        'Sencilla por fuera, muy pesada por dentro.',
      ],
      thinking: [
        'Despacio. Siempre despacio.',
        '¿Dónde está la grieta?',
        'Aprieto un poco más.',
        'Tiempo hay de sobra.',
      ],
    },
  },
  {
    id: 'amalia-vectores', name: 'Amalia Reyes', elo: 2650, title: 'IM',
    country: 'CU', emoji: '⚡', style: 'tactico', book: 'sharp',
    avatar: { bg: '#f77f00', fg: '#003049', face: 'rizos-cortos' },
    tagline: 'Da clase de tácticas mientras te las hace',
    bio: 'Enseña física en un instituto y explica el ajedrez con vectores y energía. Ataca con la misma tranquilidad con la que corrige exámenes, y le encanta contar en voz alta por qué funciona.',
    weights: { aggression: 1.4, mobility: 1.4, kingSafety: 0.9, materialism: 0.8, contempt: 20 },
    strength: {},
    favoriteOpenings: ['Defensa Siciliana, variante Najdorf', 'Gambito Volga'],
    lines: {
      greeting: [
        'Buenas. Hoy toca clase práctica, saquen el cuaderno.',
        'Le voy a explicar mis jugadas mientras se las hago.',
        'Empezamos. La energía del tablero se conserva, ya verá.',
        'Hola. Prometo ser clara y bastante incómoda.',
      ],
      win: [
        'Fin de la lección. Espero que haya tomado apuntes.',
        'La ventaja se transformó en ataque, como debía.',
        'Gané porque acumulé fuerzas antes de soltarlas.',
        'Excelente práctica. Repetimos cuando quiera.',
      ],
      lose: [
        'Me equivoqué en el signo y todo el cálculo se cayó.',
        'Buena defensa. Hoy la profesora aprende.',
        'Solté la energía antes de tiempo, error clásico.',
        'Me apunto esta partida para la clase del lunes.',
      ],
      draw: [
        'Tablas: fuerzas iguales, aceleración cero.',
        'Empate. El sistema quedó perfectamente equilibrado.',
        'Ni yo rompí su defensa ni usted la mía.',
        'Resultado correcto, aunque poco espectacular.',
      ],
      blunder: [
        'Ahí he dividido por cero, hablando en plata.',
        'Qué barbaridad, y encima delante de testigos.',
        'Un despiste tonto, de los que regaño en clase.',
        'Corrijo el planteamiento y sigo adelante.',
      ],
      check: [
        'Jaque. Su rey está en caída libre.',
        'La presión sobre esa columna era inevitable.',
        'Jaque, y observe cómo se reduce su espacio.',
        'Ese monarca ha perdido todo el apoyo.',
      ],
      brilliant: [
        '¡Ahí está! Toda la energía liberada de golpe.',
        'Esta combinación la usaré de ejemplo diez años.',
        'Sacrifiqué material por tiempo y salió redondo.',
        'Mire qué cadena de jugadas más elegante.',
      ],
      thinking: [
        'Calculo la trayectoria.',
        '¿Qué pasa si sacrifico aquí?',
        'Sumo las fuerzas del ataque.',
        'Todavía falta un dato.',
      ],
    },
  },
  {
    id: 'yusuf-cimientos', name: 'Yusuf Demir', elo: 2800, title: 'GM',
    country: 'TR', emoji: '📐', style: 'tecnico', book: 'wide',
    avatar: { bg: '#606c38', fg: '#fefae0', face: 'pelo-cano-corto' },
    tagline: 'Construye ventajas que aguantan terremotos',
    bio: 'Diseña edificios que deben sostenerse solos durante un siglo y juega con el mismo criterio. Primero los cimientos, luego la estructura, y solo al final se permite algo bonito.',
    weights: { pst: 1.3, pawnStructure: 1.3, kingSafety: 1.2, rookFiles: 1.3, mobility: 1.2, contempt: 25 },
    strength: {},
    favoriteOpenings: ['Apertura Catalana, línea abierta', 'Defensa Nimzoindia clásica'],
    lines: {
      greeting: [
        'Buenas. Primero los cimientos, después ya veremos.',
        'Todo lo que se construya hoy tendrá que sostenerse solo.',
        'Un saludo. Trabajo con planos, no con ocurrencias.',
        'Empecemos por lo aburrido, que es lo que sujeta el resto.',
      ],
      win: [
        'La estructura aguantó y la suya no. Es así de simple.',
        'Gané por diseño, no por inspiración.',
        'Cada pieza sostenía a la siguiente. Nada estaba suelto.',
        'Buena partida. El edificio quedó en pie.',
      ],
      lose: [
        'Un cálculo de carga mal hecho y se vino todo abajo.',
        'Ha encontrado usted la viga que fallaba. Enhorabuena.',
        'Mi plan era correcto y mi ejecución no lo fue.',
        'Reviso los planos y la próxima no se cae.',
      ],
      draw: [
        'Dos estructuras igual de firmes. Tablas.',
        'Empate: ninguna grieta en ninguno de los dos lados.',
        'El equilibrio era real, no hay nada que forzar.',
        'Firmo tablas sin ninguna incomodidad.',
      ],
      blunder: [
        'Ese error afea el edificio entero.',
        'He puesto una pieza donde no había apoyo. Imperdonable.',
        'Reconozco el fallo estructural y cargo con él.',
        'Refuerzo lo que queda y sigo levantando muros.',
      ],
      check: [
        'Jaque. Su rey vive en un edificio sin columnas.',
        'Esa diagonal lleva abierta desde la jugada doce.',
        'Jaque, y la salida de emergencia está tapiada.',
        'Se le ha caído la fachada por ese lado.',
      ],
      brilliant: [
        'Ahora sí: la parte bonita del proyecto.',
        'Toda la partida existía para permitir esta jugada.',
        'Elegante, y además soporta cualquier revisión.',
        'Eso es geometría, no suerte.',
      ],
      thinking: [
        'Reviso los apoyos.',
        'La estructura manda.',
        'Un plano más y decido.',
        'Aquí falta una columna.',
      ],
    },
  },
  {
    id: 'helena-teorema', name: 'Helena Vrábel', elo: 2900, title: 'GM',
    country: 'SK', emoji: '♟️', style: 'tecnico', book: 'wide',
    avatar: { bg: '#212529', fg: '#e9ecef', face: 'melena-lisa' },
    tagline: 'Dice poco y no falla casi nunca',
    bio: 'Investiga teoría de números en una universidad pequeña y trata el ajedrez como un problema más: acotado, resoluble y sin misterio. Contesta con frases cortas porque las largas le sobran.',
    weights: { pst: 1.2, pawnStructure: 1.2, mobility: 1.2, passedPawns: 1.2, aggression: 0.9, contempt: 35 },
    strength: {},
    favoriteOpenings: ['Apertura Española, variante berlinesa', 'Defensa Eslava, línea principal'],
    lines: {
      greeting: [
        'Hola. Cuando quiera.',
        'Buenas. Le escucho, o mejor dicho, le miro.',
        'Empecemos sin preámbulos, por favor.',
        'Estoy lista. No suelo tardar en estarlo.',
      ],
      win: [
        'Era lo esperado. Buena partida de todos modos.',
        'Ventaja pequeña, convertida sin incidentes.',
        'No hubo nada raro. Ese es el objetivo.',
        'Gracias. Si quiere revisamos la jugada quince.',
      ],
      lose: [
        'Correcto por su parte. Yo fallé una vez.',
        'Una imprecisión bastó. Así funciona esto.',
        'Le felicito. No es habitual y tiene mérito.',
        'Analizaré dónde se torció. Suele ser antes de lo que parece.',
      ],
      draw: [
        'Tablas. La posición no daba para más.',
        'Empate objetivo, sin discusión posible.',
        'Correcto. Ninguno cometió un error real.',
        'Acepto. Alargarlo no cambiaría nada.',
      ],
      blunder: [
        'Imprecisión. Ya está, no le doy vueltas.',
        'Ha ocurrido. No suele ocurrir.',
        'Error localizado y asumido. Continúo.',
        'Eso empeora mi posición. No la pierde.',
      ],
      check: [
        'Jaque. Solo hay una respuesta.',
        'Su rey está mal colocado desde hace rato.',
        'Jaque. Le queda una casilla.',
        'La defensa no se sostiene por ahí.',
      ],
      brilliant: [
        'Era forzado. Bonito, pero forzado.',
        'Único camino. Me alegra haberlo encontrado.',
        'Ahí la posición se resuelve sola si se mira bien.',
        'Sí. Esa jugada existe desde hace diez movimientos.',
      ],
      thinking: [
        'Un momento.',
        'Calculando la línea única.',
        'Casi está.',
        'Nada nuevo aquí.',
      ],
    },
  },
  {
    id: 'octavio-gambitos', name: 'Octavio Prats', elo: 1450, title: null,
    country: 'FR', emoji: '🗡️', style: 'romantico', book: 'sharp',
    avatar: { bg: '#9b2226', fg: '#ffddd2', face: 'perilla-fina' },
    tagline: 'No conoce una apertura sin peón regalado',
    bio: 'Da clases de esgrima en un gimnasio con espejos y juega como tira: adelante y con la punta por delante. Si una apertura no ofrece material en la tercera jugada, dice que no le interesa.',
    weights: { materialism: 0.4, aggression: 1.7, development: 1.5, kingSafety: 0.6 },
    strength: {},
    favoriteOpenings: ['Gambito Danés', 'Gambito Letón', 'Gambito de Rey aceptado'],
    lines: {
      greeting: [
        'En guardia. El peón ya está ofrecido, cójalo si se atreve.',
        'Buenas. Le regalo material en tres jugadas, es mi costumbre.',
        'Yo no defiendo, yo devuelvo el golpe antes.',
        'Empezamos: usted material, yo iniciativa. Trato hecho.',
      ],
      win: [
        'Dos peones invertidos y un rey capturado. Rentable.',
        'El que acepta el regalo se lleva también la factura.',
        'Gané con menos material y más ganas. Como siempre.',
        'Tocado. Fue un placer cruzar el acero.',
      ],
      lose: [
        'Me devolvieron la estocada y con toda la razón.',
        'Regalé demasiado y no llegué a cobrarlo.',
        'Enhorabuena: defendió como un muro y yo no soy muro.',
        'Vuelvo a la sala de armas. Y vuelvo con otro gambito.',
      ],
      draw: [
        'Tablas. Le di dos peones y me quedé sin remate.',
        'Empate incómodo para alguien que solo sabe atacar.',
        'Nadie tocó al otro en todo el asalto.',
        'Acepto, pero conste que no me gusta nada.',
      ],
      blunder: [
        'Ese sacrificio no era un sacrificio, era un despiste.',
        'Vaya, me he clavado yo solo la punta.',
        'Bueno, un peón más regalado. Ya perdí la cuenta.',
        'Sigo adelante. Retroceder no está en mi repertorio.',
      ],
      check: [
        '¡Jaque! La punta ya le toca el pecho.',
        'Su rey se ha quedado sin careta protectora.',
        'Jaque, y viene otro detrás, se lo aviso.',
        'Ahí no hay parada posible.',
      ],
      brilliant: [
        '¡Estocada perfecta, limpia y en el centro!',
        'Dos piezas por un mate. Buen negocio.',
        'Eso se estudia en las salas de esgrima, créame.',
        'El sacrificio era correcto. Yo siempre creo que lo es.',
      ],
      thinking: [
        '¿Qué puedo regalar ahora?',
        'Busco la línea abierta.',
        'El material no me interesa.',
        'Ataco o ataco.',
      ],
    },
  },
  {
    id: 'erik-cerrojo', name: 'Erik Halvorsen', elo: 1975, title: null,
    country: 'NO', emoji: '🧱', style: 'solido', book: 'solid',
    avatar: { bg: '#6b705c', fg: '#ffe8d6', face: 'barba-rubia' },
    tagline: 'Cierra todas las puertas y luego se sienta',
    bio: 'Cerrajero de guardia veinticuatro horas, se pasa la vida asegurando puertas ajenas. En el tablero hace lo mismo: primero cierra, después refuerza, y atacar le parece una imprudencia.',
    weights: { kingSafety: 2, pawnStructure: 1.8, aggression: 0.1, materialism: 1.2, mobility: 0.7, contempt: -20 },
    strength: { thinkMs: [1800, 4500] },
    favoriteOpenings: ['Defensa Caro-Kann, variante clásica cerrada', 'Defensa Philidor', 'Muro de Piedra'],
    lines: {
      greeting: [
        'Buenas. Voy a cerrar todo antes de que empiece lo feo.',
        'Yo no abro puertas, las aseguro.',
        'Hola. No espere fuegos artificiales por mi parte.',
        'Si entra en mi posición, entrará con llave prestada.',
      ],
      win: [
        'Aguanté hasta que usted se cansó. Es mi método entero.',
        'Ninguna cerradura cedió en toda la partida.',
        'Gané sin atacar ni una sola vez. Me enorgullece.',
        'Buena presión. No encontró la puerta correcta.',
      ],
      lose: [
        'Encontró la ventana que dejé sin cerrar.',
        'Una puerta floja y se cae la casa entera.',
        'Me sitiaron bien. Sin reproches.',
        'Reviso el perímetro y refuerzo para la próxima.',
      ],
      draw: [
        'Tablas. Eso, para mí, es una victoria pequeña.',
        'Nadie entró. Objetivo cumplido.',
        'Empate: el edificio sigue cerrado y entero.',
        'Perfecto así. No hacía falta más.',
      ],
      blunder: [
        'He dejado una llave puesta por fuera.',
        'Un fallo mío, justo en lo único que sé hacer.',
        'Eso abre un hueco. Voy a taparlo como sea.',
        'Nada es inexpugnable, ni siquiera yo.',
      ],
      check: [
        'Jaque. Raro en mí, pero ahí está.',
        'Se le ha quedado la puerta abierta de par en par.',
        'Jaque, y no lo digo con ninguna alegría.',
        'Su rey debería invertir en una buena cerradura.',
      ],
      brilliant: [
        'Defensa exacta. La única que aguantaba.',
        'Ese peón sostiene toda la estructura, fíjese bien.',
        'Cerrar así de bien también es una obra de arte.',
        'Llevo veinte jugadas preparando esta muralla.',
      ],
      thinking: [
        'Compruebo las cerraduras.',
        '¿Por dónde puede entrar?',
        'Refuerzo antes de mover.',
        'Aquí no pasa nadie.',
      ],
    },
  },
  {
    id: 'celeste-vivero', name: 'Celeste Aguiar', elo: 640, title: null,
    country: 'BR', emoji: '🌱', style: 'romantico', book: 'offbeat',
    avatar: { bg: '#84a98c', fg: '#fdfff5', face: 'flor-en-el-pelo' },
    tagline: 'Le da pena comer piezas y casi nunca lo hace',
    bio: 'Cuida un vivero de plantas raras y trata a las piezas como si fueran brotes. Captura solo cuando no le queda más remedio, y aun así pide perdón en voz baja antes de hacerlo.',
    weights: { materialism: 0.1, aggression: 0.3, mobility: 1.3, development: 1.2, contempt: -30 },
    strength: {},
    favoriteOpenings: ['Defensa Owen', 'Apertura del alfil de dama'],
    lines: {
      greeting: [
        'Hola. Voy a intentar que nadie salga herido hoy.',
        'Buenas. Prefiero rodear antes que arrancar de raíz.',
        'Cada pieza tarda mucho en crecer, dan ganas de cuidarla.',
        'Empezamos suave, como quien riega por la mañana.',
      ],
      win: [
        'Gané y casi no tuve que comer nada. Estoy feliz.',
        'Mi tablero termina más poblado que el tuyo.',
        'Se puede ganar sin arrasar el jardín entero.',
        'Gracias por la partida, ha sido muy tranquila.',
      ],
      lose: [
        'Perdí, pero perdí siendo yo. Eso me vale.',
        'Debí cortar esa rama a tiempo y no quise.',
        'Fuiste más directo. Yo nunca lo soy.',
        'No me arrepiento de las capturas que no hice.',
      ],
      draw: [
        'Empate con casi todas las piezas vivas. Ideal.',
        'Tablas, y el jardín entero sigue en pie.',
        'Nadie tuvo que podar de más. Qué alivio.',
        'Me llevo un empate y la conciencia tranquila.',
      ],
      blunder: [
        'Ay, dejé un brote a la intemperie.',
        'Por no querer comer, se me comieron a mí.',
        'Bueno. Era una pieza preciosa y ya no está.',
        'Me distraje mirando el alfil, que es mi favorito.',
      ],
      check: [
        'Jaque. Lo siento mucho, de verdad.',
        'Tu rey está rodeado de espinas y no fui yo.',
        'Jaque, pero no hace falta que te lo tomes a mal.',
        'Mira, tu rey se ha metido en el sitio equivocado.',
      ],
      brilliant: [
        'Qué bonita ha quedado, y sin comer nada.',
        'Esa maniobra la soñé, literalmente, anteanoche.',
        'El caballo giró como una flor abriéndose.',
        'Ha salido armónico, que es lo que busco siempre.',
      ],
      thinking: [
        '¿Puedo evitar comer?',
        'Hay otro camino, seguro.',
        'Dejo crecer la idea.',
        'Rodeo por aquí.',
      ],
    },
  },
  {
    id: 'mateo-pedales', name: 'Mateo Brizuela', elo: 1075, title: null,
    country: 'PY', emoji: '♘', style: 'caotico', book: 'offbeat',
    avatar: { bg: '#f25c54', fg: '#fff4e6', face: 'casco-bici' },
    tagline: 'Primero peones y caballos, lo demás ya veremos',
    bio: 'Reparte pedidos en bici, tiene diecisiete años y cero paciencia. Empieza siempre igual: empuja peones y saca los dos caballos, y jura que las piezas grandes solo estorban al principio.',
    weights: { pst: 0.7, aggression: 1.4, development: 1.3, mobility: 1.2, materialism: 0.9 },
    strength: {},
    favoriteOpenings: ['Ataque del caballo de rey', 'Defensa Alekhine', 'Apertura de los cuatro peones'],
    lines: {
      greeting: [
        'Hola. Primero los peoncitos, siempre los peoncitos.',
        'Vengo pedaleando, dame un segundo y arranco.',
        'Aviso: mis torres no se mueven hasta la jugada quince.',
        'Los caballos adelante, el resto que espere su turno.',
      ],
      win: [
        'Gané con los caballos y cuatro peones. Nada más.',
        'Entrega hecha, propina incluida.',
        'Te lo dije, no hacían falta las piezas pesadas.',
        'Rápido y sin frenar en ningún semáforo.',
      ],
      lose: [
        'Me faltaron las torres, que quedaron durmiendo.',
        'Buen viaje, me ganaste limpio.',
        'Ya sé, ya sé: hay que desarrollar todo. No lo haré.',
        'Pinché una rueda a mitad de camino.',
      ],
      draw: [
        'Empate. Los caballos llegaron cansados.',
        'Ninguno entregó el pedido a tiempo.',
        'Tablas, y eso que mis peones corrieron un montón.',
        'Vale, empate. Pero la próxima te alcanzo.',
      ],
      blunder: [
        'Uy, ese caballo saltó a la avenida sin mirar.',
        'Metí un peón donde no cabía ni yo con la bici.',
        'Nada, se cayó la mochila entera. Sigo igual.',
        'Eso me pasa por ir a toda velocidad. Otra vez.',
      ],
      check: [
        '¡Jaque de caballo! Mi jugada favorita del mundo.',
        'Tu rey está en la ciclovía y yo vengo rápido.',
        'Jaque, y encima con un peón. Qué vergüenza para ti.',
        'Ahí te cerré la calle entera.',
      ],
      brilliant: [
        '¡Los dos caballos bailando a la vez!',
        'Eso fue un tenedor de los que se cuentan después.',
        'Salió justo como lo pensé mientras pedaleaba.',
        'Y encima sin usar ni una torre. Aprende.',
      ],
      thinking: [
        '¿Qué peón empujo?',
        'Caballo para adelante.',
        'Las torres ni las miro.',
        'Rápido, rápido, rápido.',
      ],
    },
  },
  {
    id: 'paz-mediadora', name: 'Paz Iriondo', elo: 2275, title: 'CM',
    country: 'EC', emoji: '🤝', style: 'tecnico', book: 'solid',
    avatar: { bg: '#8ecae6', fg: '#023047', face: 'gafas-cuadradas' },
    tagline: 'Ofrece tablas en la jugada cuatro, sin ironía',
    bio: 'Media divorcios y conflictos vecinales desde hace quince años y cree que casi todo se arregla repartiendo. En el tablero busca el equilibrio con una insistencia que desespera a sus rivales.',
    weights: { contempt: -90, kingSafety: 1.4, aggression: 0.3, materialism: 1.1, pawnStructure: 1.3 },
    strength: { thinkMs: [900, 2400] },
    favoriteOpenings: ['Defensa Petrov, variante simétrica', 'Variante del cambio de la Francesa', 'Apertura Inglesa en espejo'],
    lines: {
      greeting: [
        'Buenas. ¿Aceptaría unas tablas ahora y nos ahorramos todo?',
        'Hola. Vengo en son de paz, literalmente.',
        'Le propongo un reparto justo desde el principio.',
        'Empecemos, aunque sinceramente preferiría no empezar.',
      ],
      win: [
        'Gané, pero no era mi intención. Se lo prometo.',
        'Lo intenté todo por empatar y usted no colaboró.',
        'Una victoria incómoda. Me habría bastado la mitad.',
        'Gracias. La próxima repartimos, ¿de acuerdo?',
      ],
      lose: [
        'Perdí por buscar el equilibrio donde ya no lo había.',
        'Le felicito. Yo estaba negociando y usted jugando.',
        'Debí defender en vez de proponer acuerdos.',
        'Sin rencor, de verdad. Lo digo completamente en serio.',
      ],
      draw: [
        '¡Tablas! Sabía que llegaríamos a entendernos.',
        'Esto es exactamente lo que vine a buscar.',
        'Un acuerdo limpio, sin víctimas ni vencedores.',
        'Perfecto. Nadie se va a casa enfadado.',
      ],
      blunder: [
        'Vaya, eso desequilibra justo lo que quería nivelar.',
        'Error mío, y encima rompe la simetría.',
        'Ahora tendré que trabajar para volver al empate.',
        'Qué contratiempo. Lo arreglaremos, siempre se arregla.',
      ],
      check: [
        'Jaque. Discúlpeme, no había alternativa.',
        'Tenía que darlo, aunque me incomoda bastante.',
        'Jaque, y con esto no pretendo ofender a nadie.',
        'Su rey se expuso solo, conste en acta.',
      ],
      brilliant: [
        'Encontré la línea que lleva al equilibrio exacto.',
        'Una jugada que salva y no destruye. Mi favorita.',
        'Ahí la posición se iguala hasta la última casilla.',
        'Bonita, sí, y además conciliadora.',
      ],
      thinking: [
        '¿Habrá forma de repartir?',
        'Busco la repetición.',
        'Todavía se puede igualar.',
        'Calculo hacia el empate.',
      ],
    },
  },
  {
    id: 'yeison-turbo', name: 'Yeison Palma', elo: 320, title: null,
    country: 'VE', emoji: '💨', style: 'caotico', book: 'none',
    avatar: { bg: '#00b4d8', fg: '#03045e', face: 'flequillo-largo' },
    tagline: 'Mueve antes de terminar de mirar el tablero',
    bio: 'Tiene quince años, juega a todo a máxima velocidad y considera que pensar es perder el tiempo. Mueve en menos de un segundo y luego se queja de que el tablero va demasiado lento.',
    weights: { pst: 0.4, aggression: 1.5, materialism: 0.7, kingSafety: 0.5 },
    strength: { thinkMs: [60, 220], temperature: 2.2, blunderRate: 0.4, quiescence: false, depth: 1 },
    favoriteOpenings: ['Apertura del peón de rey a toda velocidad', 'Defensa Escandinava rápida'],
    lines: {
      greeting: [
        'Dale, dale, empezá que ya moví.',
        'No pienso nada, aviso desde ahora.',
        'Rápido, que tengo otra partida esperando.',
        'Listo, ya estoy. ¿Vos por qué tardás tanto?',
      ],
      win: [
        'Gané sin pensar. Imaginate si pienso.',
        'Fue rapidísimo, ni me di cuenta de cómo.',
        'Siguiente, siguiente, dale otra.',
        'Ni miré el tablero y salió.',
      ],
      lose: [
        'Perdí, pero perdí rápido. Eso cuenta.',
        'Es que estaba mirando el chat.',
        'Revancha ya, no me hables, revancha.',
        'Bueno, esa no la vi. Ni esa ni ninguna.',
      ],
      draw: [
        'Empate. Qué aburrido, che.',
        'Nadie ganó y perdimos los dos el tiempo.',
        'Tablas, dale otra que esta no valió.',
        'Ni ganar ni perder, lo peor de los dos mundos.',
      ],
      blunder: [
        'Ah, era ahí. Bueno, ya fue.',
        'Toqué la pieza equivocada, pasa todo el tiempo.',
        'Ni lo pensé, literalmente ni lo pensé.',
        'Eso fue gratis para vos. De nada.',
      ],
      check: [
        'Jaque, creo. ¿Es jaque? Sí, es jaque.',
        'Corré que vengo sin frenos.',
        'Jaque y ya moví otra vez, seguime el ritmo.',
        'Ese rey está muerto, avisale.',
      ],
      brilliant: [
        '¿Eso fue bueno? Ni idea, pero salió.',
        'Le pegué sin apuntar y entró igual.',
        'Clip para el canal, eso estuvo tremendo.',
        'Suerte pura, pero la agarro igual.',
      ],
      thinking: [
        'Ya está, moví.',
        'Ni pienso.',
        'Rapidísimo.',
        'Cualquiera sirve.',
      ],
    },
  },
].map(Object.freeze));

const BY_ID = new Map(BOTS.map((bot) => [bot.id, bot]));

export function botById(id) {
  return BY_ID.get(id) || null;
}

/** Bots agrupados por tramo de puntuacion, de mas flojo a mas fuerte. */
export function botsByTier() {
  const groups = new Map();
  for (const bot of BOTS) {
    const tier = ratingTier(bot.elo);
    let group = groups.get(tier.key);
    if (group === undefined) {
      group = { tier, bots: [] };
      groups.set(tier.key, group);
    }
    group.bots.push(bot);
  }
  const out = [...groups.values()];
  out.sort((a, b) => a.tier.min - b.tier.min);
  for (const group of out) group.bots.sort((a, b) => a.elo - b.elo);
  return out;
}

/** Una frase del bot para ese momento, o cadena vacia si no tiene. */
export function botLine(bot, event, rng) {
  if (!bot || !bot.lines) return '';
  const list = bot.lines[event];
  if (!Array.isArray(list) || list.length === 0) return '';
  const roll = typeof rng === 'function' ? rng() : Math.random();
  const index = clamp(Math.floor(roll * list.length), 0, list.length - 1);
  return list[index];
}
