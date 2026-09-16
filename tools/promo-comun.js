/**
 * promo-comun.js — el motor de los vídeos promocionales.
 *
 * Los dos guiones (apaisado para YouTube, vertical para Shorts y TikTok)
 * comparten esto: el temporizado, el tablero, la partida que se juega y las
 * piezas y los datos de bots, que se importan del juego de verdad. Si mañana
 * cambia el dibujo de un caballo o el Elo de un bot, los vídeos se regeneran
 * al día sin tocar nada aquí.
 *
 * REGLA DE ORO: cada fotograma se dibuja a partir de su NÚMERO, nunca del
 * reloj. La misma `f` da siempre exactamente la misma imagen, así que se puede
 * capturar con un navegador sin cabeza sin que importe cuánto tarde en cargar
 * ni en qué orden salgan las cosas.
 */

import {
  createPosition, sanToMove, makeMove, moveFrom, moveTo, inCheck,
  isCapture, isCastle,
} from '../web/js/chess.js';
import { pieceSvg, botAvatarSvg } from '../web/js/pieces.js';
import { botById } from '../web/js/bots.js';

/* ==================================================================== *
 * Tiempo
 * ==================================================================== */

/*
 * Todas las duraciones de los guiones están escritas en DOCEAVOS DE SEGUNDO,
 * que es como se escribieron la primera vez. `ESCALA` las convierte a los
 * fotogramas que toquen: a 12 fps vale 1 y no cambia nada; a 24 o 30 fps
 * estira todo por igual sin tener que reescribir una sola constante.
 */
export let FPS = 12;
let ESCALA = 1;

export function configurarTiempo(fps) {
  FPS = fps;
  ESCALA = fps / 12;
}

/** Convierte una duración del guion (doceavos) a fotogramas reales. */
export const enCuadros = (unidades) => unidades * ESCALA;

export const tope = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Arranca rápido y frena: lo que hace que algo parezca que "llega". */
export const frena = (t) => 1 - Math.pow(1 - tope(t), 3);
/** Entra frenando y sale acelerando. */
export const suave = (t) => (tope(t) < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** Un rebote corto que se apaga: para carteles que entran dando un saltito. */
export const salta = (t) => {
  const u = tope(t);
  return 1 - Math.cos(u * Math.PI * 1.5) * Math.exp(-u * 4);
};

/** Progreso dentro de un tramo del guion, en 0..1. `desde` y `dura` en doceavos. */
export const tramo = (f, desde, dura) =>
  tope((f - enCuadros(desde)) / Math.max(1, enCuadros(dura)));

/** Aparece, se queda y se va. */
export function entraysale(f, desde, dura, fundido = 6) {
  const e = tramo(f, desde, fundido);
  const s = 1 - tramo(f, desde + dura - fundido, fundido);
  return Math.min(frena(e), frena(s));
}

export function px(n) { return Math.round(n * 100) / 100 + 'px'; }

/* ==================================================================== *
 * La partida que se ve: Morphy contra el duque de Brunswick y el conde
 * Isouard, Ópera de París, 1858. Es de dominio público y termina en mate
 * entregando la dama, que es justo lo que se quiere enseñar.
 * ==================================================================== */

export const OPERA = ('e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 '
  + 'Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#').split(' ');

/** Rehace la partida hasta la media jugada `ply` y devuelve todo lo pintable. */
export function partidaHasta(ply) {
  const pos = createPosition();
  const sanes = [];
  let ultima = null;
  let sonido = 'move';
  for (let i = 0; i < ply && i < OPERA.length; i += 1) {
    const mv = sanToMove(pos, OPERA[i]);
    if (mv <= 0) break;
    ultima = { desde: moveFrom(mv), hasta: moveTo(mv) };
    sonido = isCastle(mv) ? 'castle' : isCapture(mv) ? 'capture' : 'move';
    makeMove(pos, mv);
    sanes.push(OPERA[i]);
  }
  const jaque = inCheck(pos);
  return { pos, sanes, ultima, sonido, jaque: jaque ? pos.kingSq[pos.turn] : -1, enJaque: jaque };
}

/**
 * Reparto de fotogramas por media jugada. El final va más despacio para que se
 * vea la entrega de dama, que es el momento bueno. Devuelve, para cada jugada,
 * el fotograma en que aparece.
 */
export function calendarioDePlys(totalCuadros, desdePly = 0, hastaPly = OPERA.length, lentasFinales = 5) {
  const n = hastaPly - desdePly;
  const pesos = [];
  for (let i = 0; i < n; i += 1) {
    const restantes = n - i;
    pesos.push(restantes <= lentasFinales ? 3.4 : restantes <= lentasFinales * 2 ? 1.9 : 1);
  }
  const suma = pesos.reduce((a, b) => a + b, 0) || 1;
  let llevado = 0;
  return pesos.map((p) => {
    const desde = llevado;
    llevado += (p / suma) * totalCuadros;
    return { desde, hasta: llevado };
  });
}

/** Qué media jugada toca en el fotograma `local` de una escena de `dura` cuadros. */
export function plyEnFotograma(local, duraCuadros, desdePly = 0, hastaPly = OPERA.length, lentas = 5) {
  const cal = calendarioDePlys(duraCuadros, desdePly, hastaPly, lentas);
  for (let i = cal.length - 1; i >= 0; i -= 1) if (local >= cal[i].desde) return desdePly + i + 1;
  return desdePly;
}

/* ==================================================================== *
 * Tablero
 * ==================================================================== */

export function dibujarTablero(estado, lado, opts = {}) {
  const c = lado / 8;
  const trozos = [];
  for (let fila = 7; fila >= 0; fila -= 1) {
    for (let col = 0; col < 8; col += 1) {
      const sq = (fila << 4) | col;
      const clases = ['casilla', (fila + col) % 2 === 0 ? 'oscura' : 'clara'];
      if (estado.ultima && (sq === estado.ultima.desde || sq === estado.ultima.hasta)) clases.push('ultima');
      if (sq === estado.jaque) clases.push('jaque');
      trozos.push(`<div class="${clases.join(' ')}" style="left:${px(col * c)};top:${px((7 - fila) * c)};`
        + `width:${px(c)};height:${px(c)}"></div>`);
    }
  }
  for (let fila = 7; fila >= 0; fila -= 1) {
    for (let col = 0; col < 8; col += 1) {
      const pc = estado.pos.board[(fila << 4) | col];
      if (!pc) continue;
      trozos.push(`<div class="pieza" style="left:${px(col * c)};top:${px((7 - fila) * c)};`
        + `width:${px(c)};height:${px(c)}">${pieceSvg(pc, 'clasico')}</div>`);
    }
  }
  const estilo = `left:${px(opts.x || 0)};top:${px(opts.y || 0)};width:${px(lado)};height:${px(lado)};`
    + (opts.extra || '');
  return `<div class="tablero" style="${estilo}">${trozos.join('')}</div>`;
}

/* ==================================================================== *
 * Piezas de guion que usan los dos formatos
 * ==================================================================== */

/** Diez rivales repartidos por toda la escalera, del crío al gran maestro. */
export const DESFILE = [
  'pepito-migas', 'luli-caballitos', 'sarita-libreta', 'nando-brasas', 'marga-refranes',
  'wanda-bombilla', 'martina-ruta', 'hugo-relojero', 'bruno-auditor', 'soren-glaciar',
  'amalia-vectores', 'yusuf-cimientos', 'helena-teorema',
];

export const RIVALES = DESFILE.map((id) => botById(id)).filter(Boolean);

export function tarjetaRival(bot, opts = {}) {
  const ancho = opts.ancho ? `width:${px(opts.ancho)};flex:none;` : '';
  return `
    <div class="rival" style="${ancho}${opts.extra || ''}">
      <div class="cabecera">
        ${botAvatarSvg(bot, opts.avatar || 46)}
        <div style="min-width:0">
          <div class="nombre">${bot.name}</div>
          <div style="display:flex;align-items:center;gap:7px;margin-top:3px">
            <span class="elo">${bot.elo}</span>
            ${bot.title ? `<span class="titulillo">${bot.title}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="frase">${bot.tagline}</div>
    </div>`;
}

/* Las etiquetas que el juego pone de verdad a esta partida: la entrega de
   caballo en b5 y el mate con la dama regalada. */
/* En notación inglesa, que es la que muestra el juego y la que usa todo el
   mundo fuera de España. */
export const COMENTARIOS = [
  { san: '10. Nxb5', clase: 'Gran jugada', color: '#5FB3D4', letra: '!' },
  { san: '10... cxb5', clase: 'Error', color: '#D06A5A', letra: '?' },
  { san: '13. Rxd7', clase: 'Mejor jugada', color: '#81B64C', letra: '★' },
  { san: '16. Qb8+', clase: 'Brillante', color: '#3FDCBB', letra: '!!' },
];

export const MODOS = [
  { icono: '🌐', titulo: 'Online de verdad', texto: 'Partidas en directo con relojes, revancha, chat y espectadores.' },
  { icono: '🏆', titulo: 'Torneos completos', texto: 'Suizo, liga, eliminatoria y arena, con desempates de la FIDE.' },
  { icono: '🎯', titulo: 'Táctica', texto: '150 problemas verificados y los que salen de tus propias derrotas.' },
  { icono: '📈', titulo: 'Tu progreso', texto: 'Elo, Glicko-2, rachas, logros y el historial de todas tus partidas.' },
];

export const DIRECCION = 'ajedrez-maestro.onrender.com';

/** El bloque de marca: la pieza en su tarjeta clara y el nombre en dos líneas. */
export function logotipo(t, opts = {}) {
  const escala = 0.86 + 0.14 * frena(t);
  const dx = (1 - frena(tope(t * 1.25))) * (opts.empuje || 46);
  const pieza = opts.pieza || 188;
  const titulo = opts.titulo || 76;
  const raya = opts.raya === undefined ? 110 : opts.raya;
  return `
    <div style="display:flex;align-items:center;justify-content:center;gap:${px(opts.hueco || 34)};
                opacity:${frena(t * 1.4).toFixed(3)}">
      <div style="width:${px(pieza)};height:${px(pieza)};border-radius:${px(pieza * 0.14)};flex:none;
                  background:linear-gradient(160deg,#EBECD0 0%,#d9dcb8 100%);
                  box-shadow:0 22px 46px rgba(0,0,0,.6), inset 0 0 0 3px rgba(0,0,0,.14);
                  display:flex;align-items:center;justify-content:center;
                  transform:rotate(-7deg) scale(${escala.toFixed(3)}) translateX(${px(-dx)})">
        <div style="width:${px(pieza * 0.86)};height:${px(pieza * 0.86)}">${pieceSvg(2, 'clasico')}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:${px(titulo * 0.18)};transform:translateX(${px(dx)})">
        <div class="titulo" style="font-size:${px(titulo)}">
          <span style="display:block">AJEDREZ</span>
          <span style="display:block" class="verde">MAESTRO</span>
        </div>
        ${raya ? `<div style="width:${px(raya)};height:${px(titulo * 0.105)};border-radius:4px;background:#81B64C"></div>` : ''}
      </div>
    </div>`;
}

/* ==================================================================== *
 * Montaje
 * ==================================================================== */

/**
 * Arma la página. `escenas` es el guion: cada una dice cuánto dura EN DOCEAVOS
 * DE SEGUNDO y cómo se pinta. Devuelve lo que necesita el grabador.
 *
 * La URL manda:
 *   ?desde=N&cuantos=M   apila M fotogramas para sacarlos de una sola captura
 *   ?fps=N               a cuántos fotogramas por segundo (12 para el GIF, 24 o 30 para vídeo)
 *   ?datos=1             no dibuja nada: escupe el JSON con la duración y los
 *                        sonidos, que es lo que lee el grabador
 */
export function montar(escenas, opts = {}) {
  const params = new URLSearchParams(location.search);
  configurarTiempo(Number(params.get('fps')) || 12);

  let acumulado = 0;
  for (const e of escenas) {
    e.desde = acumulado;
    e.cuadros = Math.round(enCuadros(e.dura));
    acumulado += e.cuadros;
  }
  const total = acumulado;

  /* Los sonidos de cada escena, en segundos desde el principio del vídeo. */
  const eventos = [];
  for (const e of escenas) {
    if (!e.sonidos) continue;
    for (const s of e.sonidos(e)) {
      eventos.push({ t: (e.desde + s.cuadro) / FPS, sonido: s.sonido, ganancia: s.ganancia });
    }
  }
  eventos.sort((a, b) => a.t - b.t);

  const datos = { total, fps: FPS, duracion: total / FPS, eventos };
  if (params.get('datos')) {
    /* El grabador lee esto con --dump-dom, así que tiene que estar en el DOM. */
    const bolsa = document.createElement('pre');
    bolsa.id = 'datos';
    bolsa.textContent = JSON.stringify(datos);
    document.body.appendChild(bolsa);
    document.title = 'datos ' + total;
    window.PROMO = datos;
    return datos;
  }

  const desde = Number(params.get('desde')) || 0;
  const cuantos = Math.max(1, Number(params.get('cuantos')) || 1);
  const hoja = document.getElementById('hoja') || document.body;

  for (let i = 0; i < cuantos; i += 1) {
    const n = (((desde + i) % total) + total) % total;
    let escena = escenas[escenas.length - 1];
    for (const e of escenas) if (n >= e.desde && n < e.desde + e.cuadros) { escena = e; break; }
    const div = document.createElement('div');
    div.className = 'cuadro';
    div.dataset.f = String(n);
    div.innerHTML = `
      <div class="damero"></div>
      <div class="brillo"></div>
      ${escena.pinta(n - escena.desde, escena, n)}
      <div class="vineta"></div>
      ${opts.sinBarra ? '' : `<div class="avance" style="width:${(100 * (n + 1) / total).toFixed(2)}%"></div>`}`;
    hoja.appendChild(div);
  }

  document.title = 'promo ' + total;
  window.PROMO = datos;
  return datos;
}
