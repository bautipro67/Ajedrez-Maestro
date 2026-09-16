/**
 * ui/settings.js — every preference in one page: the look of the board and the
 * pieces (with a live preview that repaints as you choose), the sound, the
 * in-game assists, and the backup of everything stored in this browser.
 * Each change is written through ctx.saveSettings() the moment it happens;
 * there is no "save" button on purpose.
 */

import { el, clear, card, button, field, select, switchControl } from './components.js';
import { BOARD_THEMES, createBoard } from '../board.js';
import { PIECE_SETS } from '../pieces.js';
import { defaultSettings, loadSettings, exportAll, importAll, resetAll } from '../storage.js';

/** Opening position for the preview: both colours, minor pieces and pawns. */
const PREVIEW_FEN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5';
const PREVIEW_LAST_MOVE = { from: 'b1', to: 'c3' };

/** The assists block: setting key, visible label and a one-line explanation. */
const ASSISTS = [
  ['showLegalMoves', 'Mostrar jugadas legales',
    'Marca con un punto las casillas a las que puede ir la pieza que tocás.'],
  ['showEvalBar', 'Barra de evaluación',
    'Muestra a un lado del tablero quién está mejor según el motor.'],
  ['highlightLastMove', 'Resaltar la última jugada',
    'Pinta de amarillo la casilla de origen y la de destino de la jugada anterior.'],
  ['autoQueen', 'Coronar siempre en dama',
    'Al promocionar un peón no se abre el diálogo: se elige dama directamente.'],
  ['confirmMove', 'Confirmar cada jugada',
    'Pide una confirmación antes de enviar la jugada. Útil en pantallas táctiles.'],
  ['premove', 'Permitir premovimientos',
    'En partidas con reloj podés preparar tu respuesta mientras piensa el rival.'],
  ['showBotChat', 'Comentarios de los bots',
    'Los rivales sueltan sus frases cuando ganan material, dan jaque o se rinden.'],
];

/** Volume steps are small, so saving is debounced by this much. */
const VOLUME_SAVE_MS = 250;

/** The #/ajustes route carries no parameters; `params` is here for the contract. */
export function mount(root, ctx, params = {}) {
  const timers = new Set();
  let board = null;
  let volumeTimer = null;

  /** setTimeout that unmount() can cancel. */
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }

  /** Current settings, always read fresh: the app may swap the object on save. */
  function current() {
    return ctx.settings || defaultSettings();
  }

  /** Persist a patch and keep the object the context exposes in sync. */
  function set(patch) {
    if (ctx.settings) Object.assign(ctx.settings, patch);
    ctx.saveSettings(patch);
  }

  /**
   * Offers a text file for download without a server: Blob + object URL + a
   * throwaway anchor we click ourselves.
   */
  function download(filename, text, mime) {
    try {
      const blob = new Blob([text], { type: `${mime || 'text/plain'};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const link = el('a', { class: 'hidden', href: url, download: filename });
      document.body.appendChild(link);
      link.click();
      link.remove();
      later(() => {
        try { URL.revokeObjectURL(url); } catch { /* ya no existe */ }
      }, 2000);
      return true;
    } catch {
      ctx.toast('Tu navegador no permitió la descarga.', 'err');
      return false;
    }
  }

  const screen = el('div', { class: 'screen' });
  root.appendChild(screen);

  /* ------------------------------ vista previa ----------------------------- */

  function destroyPreview() {
    if (!board) return;
    try { board.destroy(); } catch { /* ya estaba fuera del DOM */ }
    board = null;
  }

  function createPreview(holder) {
    const s = current();
    destroyPreview();
    board = createBoard(holder, {
      interactive: false,
      showLegal: false,
      coordinates: s.showCoordinates !== false,
      theme: s.boardTheme || 'verde',
      pieceSet: s.pieceSet || 'clasico',
      animationMs: s.animations === false ? 0 : 180,
    });
    board.setPosition(PREVIEW_FEN, {
      animate: false,
      lastMove: s.highlightLastMove !== false ? PREVIEW_LAST_MOVE : null,
    });
  }

  /* --------------------------- tablero y piezas ---------------------------- */

  function boardSection() {
    const s = current();

    const holder = el('div', { style: { width: 'min(260px, 62vw)', flex: 'none' } });

    const controls = el('div', { class: 'col gap-16 grow', style: { minWidth: '240px' } });

    controls.appendChild(field('Juego de piezas', select(
      PIECE_SETS.map((item) => ({ value: item.id, label: item.name })),
      {
        value: s.pieceSet,
        ariaLabel: 'Juego de piezas',
        onChange: (event) => {
          const value = event.target.value;
          set({ pieceSet: value });
          if (board) board.setPieceSet(value);
          ctx.sound?.play('click');
        },
      },
    )));

    controls.appendChild(field('Tema del tablero', select(
      BOARD_THEMES.map((item) => ({ value: item.id, label: item.name })),
      {
        value: s.boardTheme,
        ariaLabel: 'Tema del tablero',
        onChange: (event) => {
          const value = event.target.value;
          set({ boardTheme: value });
          if (board) board.setTheme(value);
          ctx.sound?.play('click');
        },
      },
    )));

    controls.appendChild(el('div', { class: 'col gap-4' },
      switchControl('Mostrar coordenadas', {
        checked: s.showCoordinates !== false,
        onChange: (event) => {
          const on = !!event.target.checked;
          set({ showCoordinates: on });
          if (board) board.setCoordinates(on);
        },
      }),
      el('p', { class: 'tiny faint', text: 'Las letras y los números en el borde del tablero.' })));

    controls.appendChild(el('div', { class: 'col gap-4' },
      switchControl('Animar las piezas', {
        checked: s.animations !== false,
        onChange: (event) => {
          const on = !!event.target.checked;
          set({ animations: on });
          if (board) board.setAnimationMs(on ? 180 : 0);
        },
      }),
      el('p', { class: 'tiny faint', text: 'Si la desactivás, las piezas aparecen en su casilla sin deslizarse.' })));

    const node = card('Tablero y piezas',
      el('p', { class: 'muted small', style: { marginBottom: '14px' },
        text: 'Lo que elijas acá se ve al instante en la vista previa y en todas tus partidas.' }),
      el('div', { class: 'row row--wrap gap-24', style: { alignItems: 'flex-start' } },
        el('div', { class: 'col gap-6' },
          holder,
          el('p', { class: 'tiny faint center', text: 'Vista previa' })),
        controls));
    node.style.marginBottom = '16px';

    createPreview(holder);
    return node;
  }

  /* --------------------------------- sonido -------------------------------- */

  function soundSection() {
    const s = current();
    const startVolume = typeof s.volume === 'number' ? s.volume : 0.6;

    const readout = el('span', { class: 'mono small', text: percent(startVolume) });

    const slider = el('input', {
      class: 'range',
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(startVolume),
      attrs: { 'aria-label': 'Volumen de los sonidos' },
      onInput: (event) => {
        const value = clamp01(Number(event.target.value));
        readout.textContent = percent(value);
        ctx.sound?.setVolume(value);
        if (volumeTimer) clearTimeout(volumeTimer);
        volumeTimer = later(() => { volumeTimer = null; set({ volume: value }); }, VOLUME_SAVE_MS);
      },
      // The sample click lands when the handle is released, not on every step.
      onChange: (event) => {
        const value = clamp01(Number(event.target.value));
        if (volumeTimer) { clearTimeout(volumeTimer); volumeTimer = null; }
        ctx.sound?.setVolume(value);
        set({ volume: value });
        ctx.sound?.play('click');
      },
    });

    const soundOn = s.sound !== false;
    slider.disabled = !soundOn;

    const toggle = switchControl('Sonidos de la partida', {
      checked: soundOn,
      onChange: (event) => {
        const on = !!event.target.checked;
        set({ sound: on });
        ctx.sound?.setEnabled(on);
        slider.disabled = !on;
        if (on) ctx.sound?.play('click');
      },
    });

    const node = card('Sonido',
      el('div', { class: 'col gap-4' },
        toggle,
        el('p', { class: 'tiny faint', text: 'Jugadas, capturas, jaques, avisos de tiempo y final de partida.' })),
      el('div', { class: 'col gap-6', style: { marginTop: '14px' } },
        el('div', { class: 'between' },
          el('span', { class: 'field__label', text: 'Volumen' }),
          readout),
        slider));
    node.style.marginBottom = '16px';
    return node;
  }

  /* ------------------------- ayudas durante la partida --------------------- */

  function assistsSection() {
    const s = current();
    const body = el('div', {
      style: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '16px',
      },
    });

    for (const [key, label, hint] of ASSISTS) {
      body.appendChild(el('div', { class: 'col gap-4' },
        switchControl(label, {
          checked: s[key] !== false,
          onChange: (event) => {
            const on = !!event.target.checked;
            set({ [key]: on });
            // Only this one is visible on the preview board.
            if (key === 'highlightLastMove' && board) {
              board.setLastMove(on ? PREVIEW_LAST_MOVE : null);
            }
          },
        }),
        el('p', { class: 'tiny faint', text: hint })));
    }

    const node = card('Ayudas durante la partida',
      el('p', { class: 'muted small', style: { marginBottom: '14px' },
        text: 'Valen para todos los modos. Cada partida contra un bot puede afinar sus propias ayudas al empezar.' }),
      body);
    node.style.marginBottom = '16px';
    return node;
  }

  /* --------------------------------- datos --------------------------------- */

  /** After importing or wiping, pull what is on disk into the live context. */
  function adoptStoredData() {
    const stored = loadSettings();
    set(stored);
    ctx.sound?.setEnabled(stored.sound !== false);
    ctx.sound?.setVolume(typeof stored.volume === 'number' ? stored.volume : 0.6);
    if (typeof ctx.reloadProfile === 'function') ctx.reloadProfile();
  }

  function applyImport(text) {
    if (!text || !text.trim()) {
      ctx.toast('No hay nada que importar.', 'warn');
      return;
    }
    const outcome = importAll(text);
    if (!outcome.ok) {
      ctx.toast(outcome.error || 'No se pudo importar la copia.', 'err');
      return;
    }
    adoptStoredData();
    ctx.toast('Copia importada. Tus datos son los del archivo.');
    render();
  }

  function dataSection() {
    const fileInput = el('input', {
      class: 'hidden',
      type: 'file',
      attrs: { accept: 'application/json,.json', 'aria-label': 'Archivo de copia de seguridad' },
      onChange: async (event) => {
        const target = event && event.target ? event.target : fileInput;
        const file = target.files && target.files[0];
        if (!file) return;
        let text = '';
        try {
          text = typeof file.text === 'function' ? await file.text() : '';
        } catch {
          text = '';
        }
        fileInput.value = '';
        if (!text) {
          ctx.toast('No se pudo leer el archivo.', 'err');
          return;
        }
        applyImport(text);
      },
    });

    const paste = el('textarea', {
      class: 'textarea',
      attrs: { 'aria-label': 'Contenido de la copia', placeholder: '{ "app": "ajedrez-maestro", … }', rows: '5' },
    });

    const pasteBox = el('div', { class: 'col gap-6 hidden' },
      field('Pegá acá el contenido del archivo JSON', paste),
      el('div', { class: 'row gap-6' },
        button('Importar lo pegado', { variant: 'primary', size: 'sm', onClick: () => applyImport(paste.value) }),
        button('Cancelar', {
          variant: 'ghost',
          size: 'sm',
          onClick: () => { paste.value = ''; pasteBox.classList.add('hidden'); },
        })));

    const actions = el('div', { class: 'row row--wrap gap-6' },
      button('Exportar mis datos', {
        variant: 'primary',
        icon: '⬆',
        onClick: () => {
          const name = `ajedrez-maestro-copia-${new Date().toISOString().slice(0, 10)}.json`;
          if (download(name, exportAll(), 'application/json')) ctx.toast('Copia descargada.');
        },
      }),
      button('Importar desde un archivo', { icon: '⬇', onClick: () => fileInput.click() }),
      button('Pegar una copia', {
        variant: 'ghost',
        onClick: () => {
          const shown = pasteBox.classList.toggle('hidden') === false;
          if (shown) paste.focus();
        },
      }),
      button('Borrar todos los datos', {
        variant: 'danger',
        onClick: async () => {
          const sure = await ctx.confirm({
            title: 'Borrar todos los datos',
            message: 'Se borran el perfil, las puntuaciones, los logros, las partidas y los torneos guardados en este navegador. No se puede deshacer.',
            confirmLabel: 'Borrar todo',
            cancelLabel: 'Cancelar',
            danger: true,
          });
          if (!sure) return;
          resetAll();
          adoptStoredData();
          ctx.toast('Se borró todo. Empezás de cero.', 'warn');
          render();
        },
      }));

    const node = card('Tus datos',
      el('p', { class: 'muted small', style: { marginBottom: '12px' },
        text: 'Todo vive en este navegador y nunca sale de tu dispositivo. Exportá un archivo JSON para llevarte el progreso a otro lado; al importar se reemplaza lo que haya ahora.' }),
      actions,
      pasteBox,
      fileInput);
    node.style.marginBottom = '16px';
    return node;
  }

  /* -------------------------------- cabecera ------------------------------- */

  function headSection() {
    return el('div', { class: 'screen__head' },
      el('div', { class: 'col gap-4' },
        el('h1', { class: 'h1', text: 'Ajustes' }),
        el('p', { class: 'muted small', text: 'Se guardan solos, en cuanto tocás cada control.' })),
      el('div', { class: 'row row--wrap gap-6' },
        button('Restablecer los ajustes', {
          variant: 'ghost',
          onClick: async () => {
            const sure = await ctx.confirm({
              title: 'Restablecer los ajustes',
              message: 'Vuelven todos los ajustes a su valor original. Tu perfil, tus partidas y tus logros no se tocan.',
              confirmLabel: 'Restablecer',
              cancelLabel: 'Cancelar',
            });
            if (!sure) return;
            const defaults = defaultSettings();
            set(defaults);
            ctx.sound?.setEnabled(defaults.sound);
            ctx.sound?.setVolume(defaults.volume);
            ctx.toast('Ajustes restablecidos.');
            render();
          },
        }),
        el('a', { class: 'btn btn--ghost', href: '#/perfil', text: 'Ver mi perfil' })));
  }

  /* --------------------------------- pintado ------------------------------- */

  function render() {
    destroyPreview();
    clear(screen);
    screen.appendChild(headSection());
    screen.appendChild(boardSection());
    screen.appendChild(soundSection());
    screen.appendChild(assistsSection());
    screen.appendChild(dataSection());
  }

  /* The preview measures itself on drag, so it needs to know about resizes. */
  const onResize = () => { if (board) board.resize(); };
  window.addEventListener('resize', onResize);

  render();

  return {
    unmount() {
      window.removeEventListener('resize', onResize);
      if (volumeTimer) clearTimeout(volumeTimer);
      volumeTimer = null;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      destroyPreview();
      clear(screen);
    },
  };
}

/* -------------------------------- utilidades ------------------------------- */

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function percent(value) {
  return `${Math.round(clamp01(value) * 100)} %`;
}
