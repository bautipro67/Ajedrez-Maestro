/**
 * book.js — opening book and opening naming. Lines are stored as canonical SAN
 * and indexed by Zobrist key the first time the book is used, so transpositions
 * find the same entries. Environment agnostic: no DOM, no globals, and every
 * random choice comes from the caller's injected rng.
 */

import { createPosition, sanToMove, makeMove, generateMoves } from './chess.js';

/* Estilos que puede pedir un bot. 'none' significa jugar sin libro. */
export const BOOK_STYLES = Object.freeze(['wide', 'sharp', 'solid', 'offbeat']);

/* Las jugadas se guardan como una cadena separada por espacios: ocupa mucho
   menos que un array de cadenas y se lee mejor en el propio fichero. */
const RAW_LINES = [
  { eco: 'C67', name: 'Española: defensa berlinesa, final', styles: ['wide', 'solid'], sans: 'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8' },
  { eco: 'C65', name: 'Española: berlinesa, anti-berlín 4.d3', styles: ['solid', 'wide'], sans: 'e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5 c3 O-O O-O d6 Nbd2 a6 Ba4 Ba7' },
  { eco: 'C99', name: 'Española: cerrada, variante Chigorin', styles: ['wide', 'solid'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7' },
  { eco: 'C92', name: 'Española: cerrada, variante Zaitsev', styles: ['wide', 'sharp'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Bb7 d4 Re8' },
  { eco: 'C95', name: 'Española: cerrada, variante Breyer', styles: ['solid', 'wide'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7' },
  { eco: 'C80', name: 'Española: defensa abierta', styles: ['sharp', 'wide'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4 d4 b5 Bb3 d5 dxe5 Be6 c3 Bc5' },
  { eco: 'C68', name: 'Española: variante del cambio', styles: ['solid', 'wide'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4 exd4 Nxd4 c5 Ne2 Qxd1 Rxd1 Bd7' },
  { eco: 'C89', name: 'Española: ataque Marshall', styles: ['sharp', 'wide'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5 exd5 Nxd5 Nxe5 Nxe5 Rxe5 c6' },
  { eco: 'C72', name: 'Española: Steinitz diferida', styles: ['solid'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 d6 c3 Bd7 d4 Nf6 O-O Be7 Re1 O-O' },
  { eco: 'C78', name: 'Española: variante Arcángel', styles: ['sharp'], sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O b5 Bb3 Bb7 Re1 Bc5 c3 d6 d4 Bb6' },
  { eco: 'C63', name: 'Española: defensa Schliemann', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nf3 Nc6 Bb5 f5 Nc3 fxe4 Nxe4 d5 Nxe5 dxe4 Nxc6 Qg5 Qe2 Nf6' },
  { eco: 'C54', name: 'Italiana: Giuoco Piano, ataque central', styles: ['wide', 'sharp'], sans: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5 exd5 Nxd5' },
  { eco: 'C50', name: 'Italiana: Giuoco Pianissimo', styles: ['solid', 'wide'], sans: 'e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 O-O d6 c3 a6 Bb3 Ba7 Nbd2 O-O' },
  { eco: 'C58', name: 'Italiana: dos caballos, variante principal', styles: ['sharp', 'wide'], sans: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Be2 h6 Nf3 e4' },
  { eco: 'C52', name: 'Italiana: gambito Evans', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O d6 cxd4 Bb6' },
  { eco: 'C57', name: 'Italiana: dos caballos, contraataque Traxler', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 Bc5 Nxf7 Bxf2+ Kxf2 Nxe4+ Kg1 Qh4 g3 Nxg3 hxg3 Qxg3+' },
  { eco: 'C45', name: 'Escocesa: variante clásica', styles: ['wide', 'sharp'], sans: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7 Bc4 Ne5 Be2 Qg6' },
  { eco: 'C45', name: 'Escocesa: variante Mieses', styles: ['wide', 'solid'], sans: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4 Ba6' },
  { eco: 'C44', name: 'Escocesa: gambito Göring', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nf3 Nc6 d4 exd4 c3 dxc3 Nxc3 Bb4 Bc4 d6 O-O Bxc3 bxc3 Nf6' },
  { eco: 'C44', name: 'Apertura Ponziani: defensa principal', styles: ['offbeat', 'sharp'], sans: 'e4 e5 Nf3 Nc6 c3 Nf6 d4 Nxe4 d5 Ne7 Nxe5 Ng6 Qd4 f6' },
  { eco: 'C29', name: 'Vienesa: gambito de Viena', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Bg4 Qe2 Nxc3 dxc3 Be7' },
  { eco: 'C27', name: 'Vienesa: variante Frankenstein-Drácula', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nc3 Nf6 Bc4 Nxe4 Qh5 Nd6 Bb3 Nc6 Nb5 g6 Qf3 f5 Qd5 Qe7' },
  { eco: 'C39', name: 'Gambito de rey: aceptado, Kieseritzky', styles: ['sharp', 'offbeat'], sans: 'e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6 d4 d6 Nd3 Nxe4 Bxf4 Bg7' },
  { eco: 'C30', name: 'Gambito de rey: declinado clásico', styles: ['solid', 'offbeat'], sans: 'e4 e5 f4 Bc5 Nf3 d6 Nc3 Nf6 Bc4 Nc6 d3 Bg4 h3 Bxf3 Qxf3 Nd4' },
  { eco: 'C31', name: 'Gambito de rey: contragambito Falkbeer', styles: ['sharp', 'offbeat'], sans: 'e4 e5 f4 d5 exd5 e4 d3 Nf6 dxe4 Nxe4 Nf3 Bc5 Qe2 Bf5 Nc3 Qe7' },
  { eco: 'C41', name: 'Philidor: variante Hanham', styles: ['solid'], sans: 'e4 e5 Nf3 d6 d4 Nf6 Nc3 Nbd7 Bc4 Be7 O-O O-O Qe2 c6 a4 exd4' },
  { eco: 'C41', name: 'Philidor: variante Antoshin', styles: ['solid', 'offbeat'], sans: 'e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6 Nc3 Be7 Be2 O-O O-O Re8 f4 Bf8' },
  { eco: 'C42', name: 'Petrov: variante clásica', styles: ['solid', 'wide'], sans: 'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Nc6 O-O Be7 c4 Nb4' },
  { eco: 'C43', name: 'Petrov: ataque Steinitz', styles: ['solid', 'sharp'], sans: 'e4 e5 Nf3 Nf6 d4 Nxe4 Bd3 d5 Nxe5 Nd7 Nxd7 Bxd7 O-O Bd6 c4 c6' },
  { eco: 'C49', name: 'Cuatro caballos: variante simétrica', styles: ['solid', 'wide'], sans: 'e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6 Bg5 Bxc3 bxc3 Qe7' },
  { eco: 'C48', name: 'Cuatro caballos: variante Rubinstein', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Nd4 Ba4 Bc5 Nxe5 O-O Nd3 Bb6 e5 Ne8' },
  { eco: 'C24', name: 'Apertura del alfil: variante clásica', styles: ['solid', 'offbeat'], sans: 'e4 e5 Bc4 Nf6 d3 Bc5 Nf3 d6 c3 O-O O-O a6 Bb3 Ba7 Re1 Nc6' },
  { eco: 'C40', name: 'Contragambito letón: variante principal', styles: ['sharp', 'offbeat'], sans: 'e4 e5 Nf3 f5 Nxe5 Qf6 d4 d6 Nc4 fxe4 Nc3 Qg6 Ne3 Nf6 Bc4 c6' },
  { eco: 'B90', name: 'Siciliana: Najdorf, ataque inglés', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7' },
  { eco: 'B96', name: 'Siciliana: Najdorf, ataque clásico con Ag5', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Be7 Qf3 Qc7 O-O-O Nbd7' },
  { eco: 'B97', name: 'Siciliana: Najdorf, peón envenenado', styles: ['sharp', 'offbeat'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Qb6 Qd2 Qxb2 Rb1 Qa3' },
  { eco: 'B92', name: 'Siciliana: Najdorf, variante Opocensky', styles: ['solid', 'wide'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7 O-O O-O Be3 Be6' },
  { eco: 'B87', name: 'Siciliana: Najdorf, ataque Fischer-Sozin', styles: ['sharp'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bc4 e6 Bb3 b5 O-O Be7 Qf3 Qc7' },
  { eco: 'B90', name: 'Siciliana: Najdorf, variante Adams', styles: ['sharp', 'offbeat'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 h3 e5 Nde2 Be7 g4 b5 Bg2 Bb7' },
  { eco: 'B77', name: 'Siciliana: dragón, ataque yugoslavo', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6 Bc4 Bd7' },
  { eco: 'B35', name: 'Siciliana: dragón acelerada, ataque clásico', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 Nc3 Bg7 Be3 Nf6 Bc4 O-O Bb3 d6' },
  { eco: 'B36', name: 'Siciliana: dragón acelerada, muro Maroczy', styles: ['solid', 'wide'], sans: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 c4 Nf6 Nc3 d6 Be2 Nxd4 Qxd4 Bg7' },
  { eco: 'B33', name: 'Siciliana: variante Sveshnikov', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5 Bxf6 gxf6' },
  { eco: 'B66', name: 'Siciliana: clásica, ataque Richter-Rauzer', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5 e6 Qd2 a6 O-O-O Bd7 f4 b5' },
  { eco: 'B81', name: 'Siciliana: Scheveningen, ataque Keres', styles: ['sharp'], sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 d6 g4 h6 h4 Nc6 Rg1 h5' },
  { eco: 'B84', name: 'Siciliana: Scheveningen, variante clásica', styles: ['solid', 'wide'], sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 d6 Be2 Be7 O-O O-O f4 Nc6' },
  { eco: 'B48', name: 'Siciliana: variante Taimanov', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6 Qd2 Nf6 O-O-O Bb4' },
  { eco: 'B42', name: 'Siciliana: variante Kan', styles: ['solid', 'wide'], sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Nf6 O-O d6 c4 g6 Nc3 Bg7' },
  { eco: 'B45', name: 'Siciliana: cuatro caballos', styles: ['sharp', 'wide'], sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Ndb5 Bb4 a3 Bxc3+ Nxc3 d5' },
  { eco: 'B31', name: 'Siciliana: variante Rossolimo', styles: ['solid', 'wide'], sans: 'e4 c5 Nf3 Nc6 Bb5 g6 Bxc6 dxc6 d3 Bg7 h3 Nf6 Nc3 O-O Be3 b6' },
  { eco: 'B51', name: 'Siciliana: variante de Moscú', styles: ['solid', 'wide'], sans: 'e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 c4 Nf6 Nc3 g6 d4 cxd4 Nxd4 Bg7' },
  { eco: 'B22', name: 'Siciliana: Alapin con 2...Cf6', styles: ['solid', 'wide'], sans: 'e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6 Bc4 Nb6 Bb5 dxe5' },
  { eco: 'B22', name: 'Siciliana: Alapin con 2...d5', styles: ['solid'], sans: 'e4 c5 c3 d5 exd5 Qxd5 d4 Nf6 Nf3 e6 Be2 Nc6 O-O cxd4 cxd4 Be7' },
  { eco: 'B25', name: 'Siciliana: variante cerrada', styles: ['solid', 'offbeat'], sans: 'e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 f4 Nf6 Nf3 O-O O-O Rb8' },
  { eco: 'B21', name: 'Siciliana: gambito Morra', styles: ['sharp', 'offbeat'], sans: 'e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 d6 Bc4 e6 O-O Nf6 Qe2 Be7' },
  { eco: 'B32', name: 'Siciliana: variante Kalashnikov', styles: ['sharp', 'offbeat'], sans: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 e5 Nb5 d6 c4 Be7 N1c3 a6 Na3 Be6' },
  { eco: 'B23', name: 'Siciliana: ataque Gran Prix', styles: ['sharp', 'offbeat'], sans: 'e4 c5 Nc3 Nc6 f4 g6 Nf3 Bg7 Bb5 Nd4 O-O a6 Bd3 d6 Kh1 Nf6' },
  { eco: 'B28', name: 'Siciliana: variante de O\'Kelly', styles: ['offbeat', 'solid'], sans: 'e4 c5 Nf3 a6 c3 d5 exd5 Qxd5 d4 Nf6 Be2 e6 O-O Nc6 c4 Qd6' },
  { eco: 'C18', name: 'Francesa: variante Winawer, ataque de la dama', styles: ['sharp', 'wide'], sans: 'e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 Qc7 Qxg7 Rg8 Qxh7 cxd4' },
  { eco: 'C07', name: 'Francesa: variante Tarrasch con 3...c5', styles: ['solid', 'wide'], sans: 'e4 e6 d4 d5 Nd2 c5 exd5 exd5 Ngf3 Nc6 Bb5 Bd6 dxc5 Bxc5 O-O Ne7' },
  { eco: 'C06', name: 'Francesa: variante Tarrasch cerrada', styles: ['solid', 'wide'], sans: 'e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6 Ne2 cxd4 cxd4 f6' },
  { eco: 'C02', name: 'Francesa: variante del avance', styles: ['wide', 'solid'], sans: 'e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 Nh6 b4 cxd4 cxd4 Nf5' },
  { eco: 'C11', name: 'Francesa: clásica, variante Steinitz', styles: ['sharp', 'wide'], sans: 'e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6 Be3 cxd4 Nxd4 Bc5' },
  { eco: 'C12', name: 'Francesa: variante MacCutcheon', styles: ['sharp', 'offbeat'], sans: 'e4 e6 d4 d5 Nc3 Nf6 Bg5 Bb4 e5 h6 Bd2 Bxc3 bxc3 Ne4 Qg4 Kf8' },
  { eco: 'C01', name: 'Francesa: variante del cambio', styles: ['solid', 'offbeat'], sans: 'e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6 O-O O-O Bg5 Bg4 Nbd2 Nbd7' },
  { eco: 'C10', name: 'Francesa: variante Rubinstein', styles: ['solid'], sans: 'e4 e6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Nf3 Ngf6 Nxf6+ Nxf6 Bd3 c5 dxc5 Bxc5' },
  { eco: 'B19', name: 'Caro-Kann: variante clásica', styles: ['solid', 'wide'], sans: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6' },
  { eco: 'B12', name: 'Caro-Kann: variante del avance', styles: ['sharp', 'wide'], sans: 'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3 Qb6 Nc3 Ne7 O-O Nbc6' },
  { eco: 'B14', name: 'Caro-Kann: ataque Panov-Botvinnik', styles: ['sharp', 'wide'], sans: 'e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Bb4 cxd5 Nxd5 Bd2 Nc6' },
  { eco: 'B17', name: 'Caro-Kann: variante Karpov', styles: ['solid', 'wide'], sans: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Ng5 Ngf6 Bd3 e6 N1f3 Bd6 Qe2 h6' },
  { eco: 'B11', name: 'Caro-Kann: variante de los dos caballos', styles: ['solid', 'offbeat'], sans: 'e4 c6 Nc3 d5 Nf3 Bg4 h3 Bxf3 Qxf3 Nf6 d3 e6 g3 Bb4 Bd2 d4' },
  { eco: 'B13', name: 'Caro-Kann: variante del cambio', styles: ['solid', 'offbeat'], sans: 'e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Bf4 Bg4 Qb3 Qd7 Nd2 e6' },
  { eco: 'B12', name: 'Caro-Kann: variante fantasía', styles: ['sharp', 'offbeat'], sans: 'e4 c6 d4 d5 f3 dxe4 fxe4 e5 Nf3 Bg4 Bc4 Nd7 O-O Ngf6 Nc3 Bd6' },
  { eco: 'B01', name: 'Escandinava: variante clásica con 3...Da5', styles: ['solid', 'wide'], sans: 'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6 Qe2 Bb4' },
  { eco: 'B01', name: 'Escandinava: variante moderna con 3...Dd6', styles: ['solid', 'offbeat'], sans: 'e4 d5 exd5 Qxd5 Nc3 Qd6 d4 Nf6 Nf3 a6 g3 b5 Bg2 Bb7 O-O e6' },
  { eco: 'B01', name: 'Escandinava: gambito portugués', styles: ['sharp', 'offbeat'], sans: 'e4 d5 exd5 Nf6 d4 Bg4 f3 Bf5 Bb5+ Nbd7 c4 e6 dxe6 fxe6' },
  { eco: 'B01', name: 'Escandinava: variante islandesa con 2...Cf6', styles: ['solid', 'sharp'], sans: 'e4 d5 exd5 Nf6 Nf3 Nxd5 d4 Bg4 Be2 e6 O-O Be7 c4 Nb6 Nc3 O-O' },
  { eco: 'B08', name: 'Pirc: variante clásica', styles: ['solid', 'wide'], sans: 'e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O c6 a4 Nbd7 h3 e5' },
  { eco: 'B09', name: 'Pirc: ataque austríaco', styles: ['sharp', 'wide'], sans: 'e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Na6 O-O c5 d5 Rb8' },
  { eco: 'B07', name: 'Pirc: ataque 150', styles: ['sharp', 'solid'], sans: 'e4 d6 d4 Nf6 Nc3 g6 Be3 Bg7 Qd2 c6 f3 b5 Nge2 Nbd7 Bh6 Bxh6' },
  { eco: 'B06', name: 'Defensa moderna: variante con a6', styles: ['offbeat', 'sharp'], sans: 'e4 g6 d4 Bg7 Nc3 d6 f4 a6 Nf3 b5 Bd3 Nd7 O-O Bb7 Qe1 e6' },
  { eco: 'B05', name: 'Alekhine: variante moderna', styles: ['solid', 'wide'], sans: 'e4 Nf6 e5 Nd5 d4 d6 Nf3 Bg4 Be2 e6 O-O Be7 c4 Nb6 exd6 cxd6' },
  { eco: 'B03', name: 'Alekhine: ataque de los cuatro peones', styles: ['sharp', 'offbeat'], sans: 'e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 f4 dxe5 fxe5 Nc6 Be3 Bf5 Nc3 e6' },
  { eco: 'B03', name: 'Alekhine: variante del cambio', styles: ['solid', 'wide'], sans: 'e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 exd6 cxd6 Nc3 g6 Be3 Bg7 Rc1 O-O' },
  { eco: 'B00', name: 'Defensa Nimzowitsch: variante principal', styles: ['offbeat', 'sharp'], sans: 'e4 Nc6 d4 d5 Nc3 dxe4 d5 Ne5 Qd4 Ng6 Nxe4 Nf6 Nxf6+ exf6' },
  { eco: 'B00', name: 'Defensa Owen: variante clásica', styles: ['offbeat', 'solid'], sans: 'e4 b6 d4 Bb7 Bd3 e6 Nf3 c5 c3 Nf6 Qe2 d6 O-O Be7' },
  { eco: 'D63', name: 'Gambito de dama declinado: defensa ortodoxa', styles: ['solid', 'wide'], sans: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 Nf3 O-O e3 Nbd7 Rc1 c6 Bd3 dxc4 Bxc4 Nd5' },
  { eco: 'D58', name: 'Gambito de dama declinado: variante Tartakower', styles: ['solid', 'wide'], sans: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 Nf3 O-O e3 h6 Bh4 b6 cxd5 Nxd5 Bxe7 Qxe7' },
  { eco: 'D56', name: 'Gambito de dama declinado: defensa Lasker', styles: ['solid'], sans: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 Nf3 O-O e3 h6 Bh4 Ne4 Bxe7 Qxe7' },
  { eco: 'D52', name: 'Gambito de dama declinado: Cambridge Springs', styles: ['sharp', 'solid'], sans: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Nbd7 Nf3 c6 e3 Qa5 Nd2 Bb4 Qc2 O-O' },
  { eco: 'D35', name: 'Gambito de dama declinado: variante del cambio', styles: ['solid', 'wide'], sans: 'd4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 Be7 e3 c6 Bd3 Nbd7 Qc2 O-O' },
  { eco: 'D38', name: 'Gambito de dama declinado: defensa Ragozin', styles: ['sharp', 'wide'], sans: 'd4 d5 c4 e6 Nc3 Nf6 Nf3 Bb4 cxd5 exd5 Bg5 h6 Bh4 g5 Bg3 Ne4' },
  { eco: 'D27', name: 'Gambito de dama aceptado: variante clásica', styles: ['wide', 'solid'], sans: 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6 a4 Nc6 Qe2 cxd4' },
  { eco: 'D20', name: 'Gambito de dama aceptado: variante central', styles: ['sharp', 'offbeat'], sans: 'd4 d5 c4 dxc4 e4 Nf6 e5 Nd5 Bxc4 Nb6 Bd3 Nc6 Ne2 Bg4 f3 Be6' },
  { eco: 'D17', name: 'Defensa eslava: variante checa', styles: ['sharp', 'wide'], sans: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 Ne5 e6 f3 Bb4 e4 Bxe4' },
  { eco: 'D10', name: 'Defensa eslava: variante del cambio', styles: ['solid', 'offbeat'], sans: 'd4 d5 c4 c6 cxd5 cxd5 Nc3 Nf6 Nf3 Nc6 Bf4 Bf5 e3 e6 Bb5 Nd7' },
  { eco: 'D47', name: 'Semieslava: variante Meran', styles: ['sharp', 'wide'], sans: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5 Bd3 Bb7 O-O a6 e4 c5' },
  { eco: 'D44', name: 'Semieslava: variante Botvinnik', styles: ['sharp', 'offbeat'], sans: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6 Bg5 dxc4 e4 b5 e5 h6 Bh4 g5 Nxg5 hxg5' },
  { eco: 'D43', name: 'Semieslava: variante de Moscú', styles: ['solid', 'wide'], sans: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6 Bg5 h6 Bxf6 Qxf6 e3 Nd7 Bd3 dxc4 Bxc4 g6' },
  { eco: 'D34', name: 'Defensa Tarrasch: variante principal', styles: ['sharp', 'wide'], sans: 'd4 d5 c4 e6 Nc3 c5 cxd5 exd5 Nf3 Nc6 g3 Nf6 Bg2 Be7 O-O O-O' },
  { eco: 'D02', name: 'Sistema Londres: variante principal', styles: ['solid', 'wide'], sans: 'd4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O Bd3 b6' },
  { eco: 'A46', name: 'Ataque Torre: variante clásica', styles: ['solid', 'offbeat'], sans: 'd4 Nf6 Nf3 e6 Bg5 c5 e3 Be7 Nbd2 b6 Bd3 Bb7 c3 d6 O-O Nbd7' },
  { eco: 'D05', name: 'Sistema Colle: variante principal', styles: ['solid', 'offbeat'], sans: 'd4 d5 Nf3 Nf6 e3 e6 Bd3 c5 c3 Nc6 Nbd2 Bd6 O-O O-O dxc5 Bxc5' },
  { eco: 'A45', name: 'Ataque Trompowsky: variante principal', styles: ['offbeat', 'sharp'], sans: 'd4 Nf6 Bg5 Ne4 Bf4 d5 e3 c5 Bd3 Nc6 Nf3 Qb6 Qc1 Bf5 c3 e6' },
  { eco: 'D08', name: 'Contragambito Albin: variante principal', styles: ['sharp', 'offbeat'], sans: 'd4 d5 c4 e5 dxe5 d4 Nf3 Nc6 a3 Be6 Nbd2 Qd7 g3 O-O-O Bg2 Nge7' },
  { eco: 'D07', name: 'Defensa Chigorin: variante principal', styles: ['offbeat', 'sharp'], sans: 'd4 d5 c4 Nc6 Nc3 dxc4 Nf3 Nf6 e4 Bg4 d5 Ne5 Bf4 Ng6 Be3 e6' },
  { eco: 'D00', name: 'Gambito Blackmar-Diemer: aceptado', styles: ['sharp', 'offbeat'], sans: 'd4 d5 e4 dxe4 Nc3 Nf6 f3 exf3 Nxf3 g6 Bc4 Bg7 O-O O-O Qe1 Nc6' },
  { eco: 'E05', name: 'Catalana: variante abierta', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6 Qxc4 b5' },
  { eco: 'E08', name: 'Catalana: variante cerrada', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O Nbd7 Qc2 c6 Nbd2 b6' },
  { eco: 'E48', name: 'Nimzoindia: variante Rubinstein', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O dxc4 Bxc4 Nbd7' },
  { eco: 'E32', name: 'Nimzoindia: variante clásica de Capablanca', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6 Bg5 Bb7 f3 h6' },
  { eco: 'E24', name: 'Nimzoindia: variante Sämisch', styles: ['sharp', 'offbeat'], sans: 'd4 Nf6 c4 e6 Nc3 Bb4 a3 Bxc3+ bxc3 c5 f3 d5 cxd5 Nxd5 dxc5 f5' },
  { eco: 'E41', name: 'Nimzoindia: variante Hübner', styles: ['solid', 'sharp'], sans: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 c5 Bd3 Nc6 Nf3 Bxc3+ bxc3 d6 e4 e5' },
  { eco: 'E15', name: 'India de dama: variante del fianchetto con Aa6', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 Nf3 b6 g3 Ba6 b3 Bb4+ Bd2 Be7 Bg2 c6 Bc3 d5' },
  { eco: 'E17', name: 'India de dama: variante clásica', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7 O-O O-O Nc3 Ne4 Qc2 Nxc3' },
  { eco: 'E12', name: 'India de dama: variante Petrosian', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 Nf3 b6 a3 Bb7 Nc3 d5 cxd5 Nxd5 Qc2 Nxc3 bxc3 Be7' },
  { eco: 'E97', name: 'India de rey: variante clásica', styles: ['sharp', 'wide'], sans: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7' },
  { eco: 'E81', name: 'India de rey: variante Sämisch', styles: ['sharp', 'wide'], sans: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5 d5 Nh5 Qd2 f5' },
  { eco: 'E76', name: 'India de rey: ataque de los cuatro peones', styles: ['sharp', 'offbeat'], sans: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f4 O-O Nf3 c5 d5 e6 Be2 exd5' },
  { eco: 'E68', name: 'India de rey: variante del fianchetto', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 g6 g3 Bg7 Bg2 O-O Nf3 d6 O-O Nbd7 Nc3 e5 e4 c6' },
  { eco: 'E73', name: 'India de rey: sistema Averbaj', styles: ['solid', 'sharp'], sans: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Be2 O-O Bg5 c5 d5 e6 Qd2 exd5' },
  { eco: 'D85', name: 'Grünfeld: variante del cambio', styles: ['sharp', 'wide'], sans: 'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5 Rb1 O-O' },
  { eco: 'D97', name: 'Grünfeld: variante rusa', styles: ['sharp', 'wide'], sans: 'd4 Nf6 c4 g6 Nc3 d5 Nf3 Bg7 Qb3 dxc4 Qxc4 O-O e4 a6 Be2 b5' },
  { eco: 'D78', name: 'Grünfeld: variante del fianchetto', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 g6 Nf3 Bg7 g3 d5 Bg2 O-O O-O c6 cxd5 cxd5 Nc3 Ne4' },
  { eco: 'A70', name: 'Benoni moderna: variante clásica', styles: ['sharp', 'wide'], sans: 'd4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7 Be2 O-O' },
  { eco: 'A67', name: 'Benoni moderna: ataque Taimanov', styles: ['sharp', 'offbeat'], sans: 'd4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 f4 Bg7 Bb5+ Nfd7' },
  { eco: 'A56', name: 'Benoni checa: variante principal', styles: ['solid', 'offbeat'], sans: 'd4 Nf6 c4 c5 d5 e5 Nc3 d6 e4 Be7 Nf3 O-O Be2 Ne8 O-O g6' },
  { eco: 'A58', name: 'Gambito Benko: variante aceptada', styles: ['sharp', 'offbeat'], sans: 'd4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 Bxa6 Nc3 d6 e4 Bxf1 Kxf1 g6' },
  { eco: 'A52', name: 'Gambito Budapest: variante principal', styles: ['sharp', 'offbeat'], sans: 'd4 Nf6 c4 e5 dxe5 Ng4 Bf4 Nc6 Nf3 Bb4+ Nbd2 Qe7 a3 Ngxe5' },
  { eco: 'A51', name: 'Gambito Budapest: variante Fajarowicz', styles: ['offbeat', 'sharp'], sans: 'd4 Nf6 c4 e5 dxe5 Ne4 Nf3 Nc6 a3 d6 Qc2 Bf5 Nc3 Nxc3' },
  { eco: 'A87', name: 'Holandesa: variante Leningrado', styles: ['sharp', 'wide'], sans: 'd4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O c4 d6 Nc3 Qe8 d5 Na6' },
  { eco: 'A90', name: 'Holandesa: variante Stonewall', styles: ['solid', 'wide'], sans: 'd4 f5 c4 Nf6 g3 e6 Bg2 d5 Nf3 c6 O-O Bd6 b3 Qe7 Bb2 b6' },
  { eco: 'A96', name: 'Holandesa: variante clásica', styles: ['solid', 'wide'], sans: 'd4 f5 c4 Nf6 g3 e6 Bg2 Be7 Nf3 O-O O-O d6 Nc3 Qe8 Re1 Qg6' },
  { eco: 'A83', name: 'Holandesa: gambito Staunton', styles: ['sharp', 'offbeat'], sans: 'd4 f5 e4 fxe4 Nc3 Nf6 Bg5 g6 f3 exf3 Nxf3 Bg7 Bd3 d5' },
  { eco: 'E11', name: 'Bogoindia: variante principal', styles: ['solid', 'wide'], sans: 'd4 Nf6 c4 e6 Nf3 Bb4+ Bd2 Qe7 g3 Nc6 Bg2 Bxd2+ Nbxd2 d6 O-O O-O' },
  { eco: 'A55', name: 'India antigua: variante principal', styles: ['solid', 'offbeat'], sans: 'd4 Nf6 c4 d6 Nc3 e5 Nf3 Nbd7 e4 Be7 Be2 O-O O-O c6 Qc2 Qc7' },
  { eco: 'A34', name: 'Inglesa: variante simétrica', styles: ['wide', 'solid'], sans: 'c4 c5 Nf3 Nf6 Nc3 Nc6 d4 cxd4 Nxd4 e6 g3 Qb6 Nb3 Ne5 e4 Bb4' },
  { eco: 'A29', name: 'Inglesa: cuatro caballos con fianchetto', styles: ['wide', 'solid'], sans: 'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 Bb4 Bg2 O-O O-O Re8 Nd5 Bf8 d3 h6' },
  { eco: 'A25', name: 'Inglesa: siciliana invertida', styles: ['sharp', 'wide'], sans: 'c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 Rb1 f5 b4 Nf6 b5 Ne7' },
  { eco: 'A30', name: 'Inglesa: sistema del erizo', styles: ['solid', 'offbeat'], sans: 'c4 c5 Nf3 Nf6 g3 b6 Bg2 Bb7 O-O e6 Nc3 a6 d4 cxd4 Qxd4 d6' },
  { eco: 'A26', name: 'Inglesa: sistema Botvinnik', styles: ['solid', 'wide'], sans: 'c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 e4 Nge7 Nge2 O-O O-O f5' },
  { eco: 'A18', name: 'Inglesa: variante Mikenas-Carls', styles: ['sharp', 'offbeat'], sans: 'c4 Nf6 Nc3 e6 e4 d5 e5 d4 exf6 dxc3 bxc3 Qxf6 Nf3 e5 d4 e4' },
  { eco: 'A14', name: 'Apertura Reti: variante clásica', styles: ['solid', 'wide'], sans: 'Nf3 d5 c4 e6 g3 Nf6 Bg2 Be7 O-O O-O b3 c5 Bb2 Nc6 e3 b6' },
  { eco: 'A09', name: 'Apertura Reti: gambito aceptado', styles: ['solid', 'offbeat'], sans: 'Nf3 d5 c4 dxc4 e3 Nf6 Bxc4 e6 O-O c5 b3 Nc6 Bb2 a6 a4 Be7' },
  { eco: 'A07', name: 'Ataque indio de rey: variante principal', styles: ['solid', 'offbeat'], sans: 'Nf3 d5 g3 Nf6 Bg2 c6 O-O Bg4 d3 Nbd7 Nbd2 e5 e4 Bd6 b3 O-O' },
  { eco: 'A03', name: 'Apertura Bird: variante clásica', styles: ['offbeat', 'sharp'], sans: 'f4 d5 Nf3 Nf6 e3 g6 Be2 Bg7 O-O O-O d3 c5 Qe1 Nc6 Nc3 d4' },
  { eco: 'A02', name: 'Apertura Bird: gambito From', styles: ['sharp', 'offbeat'], sans: 'f4 e5 fxe5 d6 exd6 Bxd6 Nf3 g5 d4 g4 Ne5 Bxe5 dxe5 Qxd1+ Kxd1 Nc6' },
  { eco: 'A01', name: 'Apertura Nimzo-Larsen: variante principal', styles: ['offbeat', 'solid'], sans: 'b3 d5 Bb2 Nf6 Nf3 e6 e3 Be7 c4 O-O Nc3 c5 cxd5 Nxd5 Nxd5 exd5' },
  { eco: 'A00', name: 'Apertura Sokolsky: variante principal', styles: ['offbeat', 'sharp'], sans: 'b4 e5 Bb2 Bxb4 Bxe5 Nf6 Nf3 Nc6 Bb2 O-O e3 d5 Be2 Re8' },
];

const RAW_NAMES = [
  { eco: 'C20', name: 'Apertura de peón de rey', sans: 'e4' },
  { eco: 'A40', name: 'Apertura de peón de dama', sans: 'd4' },
  { eco: 'A10', name: 'Apertura inglesa', sans: 'c4' },
  { eco: 'A04', name: 'Apertura Reti', sans: 'Nf3' },
  { eco: 'A02', name: 'Apertura Bird', sans: 'f4' },
  { eco: 'A01', name: 'Apertura Nimzo-Larsen', sans: 'b3' },
  { eco: 'A00', name: 'Apertura Sokolsky', sans: 'b4' },
  { eco: 'A00', name: 'Apertura Grob', sans: 'g4' },
  { eco: 'A00', name: 'Apertura Anderssen', sans: 'a3' },
  { eco: 'C20', name: 'Juego abierto', sans: 'e4 e5' },
  { eco: 'B20', name: 'Defensa siciliana', sans: 'e4 c5' },
  { eco: 'C00', name: 'Defensa francesa', sans: 'e4 e6' },
  { eco: 'B10', name: 'Defensa Caro-Kann', sans: 'e4 c6' },
  { eco: 'B01', name: 'Defensa escandinava', sans: 'e4 d5' },
  { eco: 'B07', name: 'Defensa Pirc', sans: 'e4 d6' },
  { eco: 'B06', name: 'Defensa moderna', sans: 'e4 g6' },
  { eco: 'B02', name: 'Defensa Alekhine', sans: 'e4 Nf6' },
  { eco: 'B00', name: 'Defensa Nimzowitsch', sans: 'e4 Nc6' },
  { eco: 'B00', name: 'Defensa Owen', sans: 'e4 b6' },
  { eco: 'C40', name: 'Apertura del caballo de rey', sans: 'e4 e5 Nf3' },
  { eco: 'C30', name: 'Gambito de rey', sans: 'e4 e5 f4' },
  { eco: 'C33', name: 'Gambito de rey aceptado', sans: 'e4 e5 f4 exf4' },
  { eco: 'C30', name: 'Gambito de rey declinado', sans: 'e4 e5 f4 Bc5' },
  { eco: 'C31', name: 'Contragambito Falkbeer', sans: 'e4 e5 f4 d5' },
  { eco: 'C25', name: 'Apertura vienesa', sans: 'e4 e5 Nc3' },
  { eco: 'C23', name: 'Apertura del alfil', sans: 'e4 e5 Bc4' },
  { eco: 'C41', name: 'Defensa Philidor', sans: 'e4 e5 Nf3 d6' },
  { eco: 'C42', name: 'Defensa Petrov', sans: 'e4 e5 Nf3 Nf6' },
  { eco: 'C40', name: 'Contragambito letón', sans: 'e4 e5 Nf3 f5' },
  { eco: 'C44', name: 'Apertura escocesa', sans: 'e4 e5 Nf3 Nc6 d4' },
  { eco: 'C44', name: 'Apertura Ponziani', sans: 'e4 e5 Nf3 Nc6 c3' },
  { eco: 'C47', name: 'Apertura de los cuatro caballos', sans: 'e4 e5 Nf3 Nc6 Nc3 Nf6' },
  { eco: 'C50', name: 'Apertura italiana', sans: 'e4 e5 Nf3 Nc6 Bc4' },
  { eco: 'C53', name: 'Italiana: Giuoco Piano', sans: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3' },
  { eco: 'C52', name: 'Italiana: gambito Evans', sans: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4' },
  { eco: 'C55', name: 'Defensa de los dos caballos', sans: 'e4 e5 Nf3 Nc6 Bc4 Nf6' },
  { eco: 'C57', name: 'Dos caballos: contraataque Traxler', sans: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 Bc5' },
  { eco: 'C60', name: 'Apertura española', sans: 'e4 e5 Nf3 Nc6 Bb5' },
  { eco: 'C65', name: 'Española: defensa berlinesa', sans: 'e4 e5 Nf3 Nc6 Bb5 Nf6' },
  { eco: 'C63', name: 'Española: defensa Schliemann', sans: 'e4 e5 Nf3 Nc6 Bb5 f5' },
  { eco: 'C68', name: 'Española: variante del cambio', sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6' },
  { eco: 'C70', name: 'Española: variante Morphy', sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4' },
  { eco: 'C80', name: 'Española: defensa abierta', sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4' },
  { eco: 'C88', name: 'Española: defensa cerrada', sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5' },
  { eco: 'C78', name: 'Española: variante Arcángel', sans: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O b5 Bb3 Bb7' },
  { eco: 'B22', name: 'Siciliana: variante Alapin', sans: 'e4 c5 c3' },
  { eco: 'B23', name: 'Siciliana: variante cerrada', sans: 'e4 c5 Nc3' },
  { eco: 'B23', name: 'Siciliana: ataque Gran Prix', sans: 'e4 c5 Nc3 Nc6 f4' },
  { eco: 'B21', name: 'Siciliana: gambito Morra', sans: 'e4 c5 d4 cxd4 c3' },
  { eco: 'B31', name: 'Siciliana: variante Rossolimo', sans: 'e4 c5 Nf3 Nc6 Bb5' },
  { eco: 'B51', name: 'Siciliana: variante de Moscú', sans: 'e4 c5 Nf3 d6 Bb5+' },
  { eco: 'B28', name: 'Siciliana: variante de O\'Kelly', sans: 'e4 c5 Nf3 a6' },
  { eco: 'B50', name: 'Siciliana: variante abierta', sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4' },
  { eco: 'B90', name: 'Siciliana: variante Najdorf', sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6' },
  { eco: 'B70', name: 'Siciliana: variante del dragón', sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6' },
  { eco: 'B60', name: 'Siciliana: variante clásica', sans: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6' },
  { eco: 'B80', name: 'Siciliana: variante Scheveningen', sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 d6' },
  { eco: 'B33', name: 'Siciliana: variante Sveshnikov', sans: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5' },
  { eco: 'B34', name: 'Siciliana: dragón acelerada', sans: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6' },
  { eco: 'B46', name: 'Siciliana: variante Taimanov', sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6' },
  { eco: 'B41', name: 'Siciliana: variante Kan', sans: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6' },
  { eco: 'B32', name: 'Siciliana: variante Kalashnikov', sans: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 e5 Nb5 d6' },
  { eco: 'C02', name: 'Francesa: variante del avance', sans: 'e4 e6 d4 d5 e5' },
  { eco: 'C01', name: 'Francesa: variante del cambio', sans: 'e4 e6 d4 d5 exd5' },
  { eco: 'C03', name: 'Francesa: variante Tarrasch', sans: 'e4 e6 d4 d5 Nd2' },
  { eco: 'C18', name: 'Francesa: variante Winawer', sans: 'e4 e6 d4 d5 Nc3 Bb4' },
  { eco: 'C11', name: 'Francesa: variante clásica', sans: 'e4 e6 d4 d5 Nc3 Nf6' },
  { eco: 'C10', name: 'Francesa: variante Rubinstein', sans: 'e4 e6 d4 d5 Nc3 dxe4' },
  { eco: 'C12', name: 'Francesa: variante MacCutcheon', sans: 'e4 e6 d4 d5 Nc3 Nf6 Bg5 Bb4' },
  { eco: 'B12', name: 'Caro-Kann: variante del avance', sans: 'e4 c6 d4 d5 e5' },
  { eco: 'B12', name: 'Caro-Kann: variante fantasía', sans: 'e4 c6 d4 d5 f3' },
  { eco: 'B13', name: 'Caro-Kann: variante del cambio', sans: 'e4 c6 d4 d5 exd5 cxd5 Bd3' },
  { eco: 'B14', name: 'Caro-Kann: ataque Panov-Botvinnik', sans: 'e4 c6 d4 d5 exd5 cxd5 c4' },
  { eco: 'B18', name: 'Caro-Kann: variante clásica', sans: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5' },
  { eco: 'B17', name: 'Caro-Kann: variante Karpov', sans: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7' },
  { eco: 'B11', name: 'Caro-Kann: variante de los dos caballos', sans: 'e4 c6 Nc3 d5 Nf3' },
  { eco: 'B01', name: 'Escandinava: variante con 3...Da5', sans: 'e4 d5 exd5 Qxd5 Nc3 Qa5' },
  { eco: 'B01', name: 'Escandinava: variante con 3...Dd6', sans: 'e4 d5 exd5 Qxd5 Nc3 Qd6' },
  { eco: 'B01', name: 'Escandinava: variante con 2...Cf6', sans: 'e4 d5 exd5 Nf6' },
  { eco: 'B01', name: 'Escandinava: gambito portugués', sans: 'e4 d5 exd5 Nf6 d4 Bg4' },
  { eco: 'B09', name: 'Pirc: ataque austríaco', sans: 'e4 d6 d4 Nf6 Nc3 g6 f4' },
  { eco: 'B08', name: 'Pirc: variante clásica', sans: 'e4 d6 d4 Nf6 Nc3 g6 Nf3' },
  { eco: 'B07', name: 'Pirc: ataque 150', sans: 'e4 d6 d4 Nf6 Nc3 g6 Be3' },
  { eco: 'B04', name: 'Alekhine: variante moderna', sans: 'e4 Nf6 e5 Nd5 d4 d6 Nf3' },
  { eco: 'B03', name: 'Alekhine: ataque de los cuatro peones', sans: 'e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 f4' },
  { eco: 'D00', name: 'Peón de dama: defensa simétrica', sans: 'd4 d5' },
  { eco: 'A45', name: 'Defensas indias', sans: 'd4 Nf6' },
  { eco: 'D06', name: 'Gambito de dama', sans: 'd4 d5 c4' },
  { eco: 'D20', name: 'Gambito de dama aceptado', sans: 'd4 d5 c4 dxc4' },
  { eco: 'D30', name: 'Gambito de dama declinado', sans: 'd4 d5 c4 e6' },
  { eco: 'D10', name: 'Defensa eslava', sans: 'd4 d5 c4 c6' },
  { eco: 'D43', name: 'Defensa semieslava', sans: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6' },
  { eco: 'D32', name: 'Defensa Tarrasch', sans: 'd4 d5 c4 e6 Nc3 c5' },
  { eco: 'D07', name: 'Defensa Chigorin', sans: 'd4 d5 c4 Nc6' },
  { eco: 'D08', name: 'Contragambito Albin', sans: 'd4 d5 c4 e5' },
  { eco: 'D35', name: 'Gambito de dama: variante del cambio', sans: 'd4 d5 c4 e6 Nc3 Nf6 cxd5' },
  { eco: 'D51', name: 'Gambito de dama: variante ortodoxa', sans: 'd4 d5 c4 e6 Nc3 Nf6 Bg5' },
  { eco: 'D52', name: 'Gambito de dama: Cambridge Springs', sans: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Nbd7 Nf3 c6 e3 Qa5' },
  { eco: 'D02', name: 'Sistema Londres', sans: 'd4 d5 Bf4' },
  { eco: 'D05', name: 'Sistema Colle', sans: 'd4 d5 Nf3 Nf6 e3' },
  { eco: 'D00', name: 'Gambito Blackmar-Diemer', sans: 'd4 d5 e4' },
  { eco: 'A45', name: 'Ataque Trompowsky', sans: 'd4 Nf6 Bg5' },
  { eco: 'A46', name: 'Ataque Torre', sans: 'd4 Nf6 Nf3 e6 Bg5' },
  { eco: 'E20', name: 'Defensa nimzoindia', sans: 'd4 Nf6 c4 e6 Nc3 Bb4' },
  { eco: 'E24', name: 'Nimzoindia: variante Sämisch', sans: 'd4 Nf6 c4 e6 Nc3 Bb4 a3' },
  { eco: 'E40', name: 'Nimzoindia: variante Rubinstein', sans: 'd4 Nf6 c4 e6 Nc3 Bb4 e3' },
  { eco: 'E32', name: 'Nimzoindia: variante clásica', sans: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2' },
  { eco: 'E12', name: 'Defensa india de dama', sans: 'd4 Nf6 c4 e6 Nf3 b6' },
  { eco: 'E11', name: 'Defensa bogoindia', sans: 'd4 Nf6 c4 e6 Nf3 Bb4+' },
  { eco: 'E00', name: 'Apertura catalana', sans: 'd4 Nf6 c4 e6 g3' },
  { eco: 'E60', name: 'Defensa india de rey', sans: 'd4 Nf6 c4 g6' },
  { eco: 'E62', name: 'India de rey: variante del fianchetto', sans: 'd4 Nf6 c4 g6 g3' },
  { eco: 'E80', name: 'India de rey: variante Sämisch', sans: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3' },
  { eco: 'E90', name: 'India de rey: variante clásica', sans: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3' },
  { eco: 'E76', name: 'India de rey: ataque de los cuatro peones', sans: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f4' },
  { eco: 'D80', name: 'Defensa Grünfeld', sans: 'd4 Nf6 c4 g6 Nc3 d5' },
  { eco: 'D85', name: 'Grünfeld: variante del cambio', sans: 'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4' },
  { eco: 'D97', name: 'Grünfeld: variante rusa', sans: 'd4 Nf6 c4 g6 Nc3 d5 Nf3 Bg7 Qb3' },
  { eco: 'A56', name: 'Defensa Benoni', sans: 'd4 Nf6 c4 c5' },
  { eco: 'A60', name: 'Benoni moderna', sans: 'd4 Nf6 c4 c5 d5 e6' },
  { eco: 'A57', name: 'Gambito Benko', sans: 'd4 Nf6 c4 c5 d5 b5' },
  { eco: 'A52', name: 'Gambito Budapest', sans: 'd4 Nf6 c4 e5' },
  { eco: 'A51', name: 'Budapest: variante Fajarowicz', sans: 'd4 Nf6 c4 e5 dxe5 Ne4' },
  { eco: 'A50', name: 'Defensa india antigua', sans: 'd4 Nf6 c4 d6' },
  { eco: 'A80', name: 'Defensa holandesa', sans: 'd4 f5' },
  { eco: 'A83', name: 'Holandesa: gambito Staunton', sans: 'd4 f5 e4' },
  { eco: 'A87', name: 'Holandesa: variante Leningrado', sans: 'd4 f5 g3 Nf6 Bg2 g6' },
  { eco: 'A90', name: 'Holandesa: variante Stonewall', sans: 'd4 f5 c4 Nf6 g3 e6 Bg2 d5' },
  { eco: 'A96', name: 'Holandesa: variante clásica', sans: 'd4 f5 c4 Nf6 g3 e6 Bg2 Be7' },
  { eco: 'A20', name: 'Inglesa: apertura inversa', sans: 'c4 e5' },
  { eco: 'A30', name: 'Inglesa: variante simétrica', sans: 'c4 c5' },
  { eco: 'A29', name: 'Inglesa: cuatro caballos', sans: 'c4 e5 Nc3 Nf6 Nf3 Nc6' },
  { eco: 'A26', name: 'Inglesa: sistema Botvinnik', sans: 'c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 e4' },
  { eco: 'A30', name: 'Inglesa: sistema del erizo', sans: 'c4 c5 Nf3 Nf6 g3 b6' },
  { eco: 'A18', name: 'Inglesa: variante Mikenas-Carls', sans: 'c4 Nf6 Nc3 e6 e4' },
  { eco: 'A09', name: 'Reti: gambito aceptado', sans: 'Nf3 d5 c4 dxc4' },
  { eco: 'A07', name: 'Ataque indio de rey', sans: 'Nf3 d5 g3' },
  { eco: 'A02', name: 'Bird: gambito From', sans: 'f4 e5' },
];

/** Una entrada del libro: `sans` ya troceado en jugadas sueltas. */
function expand(entry) {
  return Object.freeze({
    eco: entry.eco,
    name: entry.name,
    styles: Object.freeze(entry.styles ? entry.styles.slice() : []),
    sans: Object.freeze(entry.sans.split(' ')),
  });
}

export const BOOK_LINES = Object.freeze(RAW_LINES.map(expand));
export const OPENING_NAMES = Object.freeze(RAW_NAMES.map(expand));

/* --------------------------- indice de jugadas --------------------------- */

let moveIndex = null;

function positionKey(pos) {
  return pos.keyLo + ':' + pos.keyHi;
}

/**
 * Recorre cada linea desde la posicion inicial y anota, para cada posicion por
 * la que pasa, que jugada sigue. El peso de una jugada es cuantas lineas del
 * libro la avalan, asi que las jugadas principales salen mas a menudo.
 */
function buildMoveIndex() {
  const map = new Map();
  for (const line of BOOK_LINES) {
    const pos = createPosition();
    for (const san of line.sans) {
      const move = sanToMove(pos, san);
      if (move === -1) break;
      const key = positionKey(pos);
      let bucket = map.get(key);
      if (bucket === undefined) {
        bucket = [];
        map.set(key, bucket);
      }
      let entry = null;
      for (const candidate of bucket) {
        if (candidate.move === move) {
          entry = candidate;
          break;
        }
      }
      if (entry === null) {
        entry = { move, weight: 0, styles: new Set() };
        bucket.push(entry);
      }
      entry.weight++;
      for (const style of line.styles) entry.styles.add(style);
      makeMove(pos, move);
    }
  }
  return map;
}

/**
 * Jugada de libro para `pos`, o -1 si esta posicion no esta en el libro o no
 * hay nada del estilo pedido (en cuyo caso el bot sale del libro y piensa).
 */
export function bookMove(pos, style, rng) {
  if (!style || style === 'none') return -1;
  if (moveIndex === null) moveIndex = buildMoveIndex();

  const bucket = moveIndex.get(positionKey(pos));
  if (bucket === undefined) return -1;

  /* La clave Zobrist podria colisionar: comprobamos legalidad de verdad. */
  const legal = generateMoves(pos);
  const candidates = [];
  let total = 0;
  for (const entry of bucket) {
    if (!entry.styles.has(style)) continue;
    if (!legal.includes(entry.move)) continue;
    candidates.push(entry);
    total += entry.weight;
  }
  if (candidates.length === 0) return -1;

  const roll = (typeof rng === 'function' ? rng() : Math.random()) * total;
  let acc = 0;
  for (const entry of candidates) {
    acc += entry.weight;
    if (roll < acc) return entry.move;
  }
  return candidates[candidates.length - 1].move;
}

/** Cuantas jugadas distintas ofrece el libro en esta posicion, por estilo. */
export function bookOptions(pos, style) {
  if (moveIndex === null) moveIndex = buildMoveIndex();
  const bucket = moveIndex.get(positionKey(pos));
  if (bucket === undefined) return 0;
  if (!style || style === 'none') return bucket.length;
  let n = 0;
  for (const entry of bucket) if (entry.styles.has(style)) n++;
  return n;
}

/* ---------------------------- nombre de apertura -------------------------- */

let nameIndex = null;
let longestName = 0;

function buildNameIndex() {
  const map = new Map();
  for (const entry of OPENING_NAMES) {
    const key = entry.sans.join(' ');
    if (!map.has(key)) map.set(key, entry);
    if (entry.sans.length > longestName) longestName = entry.sans.length;
  }
  /* Las propias lineas del libro sirven de nombre cuando la partida las sigue
     entera: son mas especificas que la tabla corta. */
  for (const line of BOOK_LINES) {
    const key = line.sans.join(' ');
    if (!map.has(key)) map.set(key, line);
    if (line.sans.length > longestName) longestName = line.sans.length;
  }
  return map;
}

/**
 * Nombre de la apertura a partir de las jugadas en SAN, buscando el prefijo
 * mas largo que coincida. Devuelve `{eco, name}` o `null`.
 */
export function openingName(sanMoves) {
  if (!Array.isArray(sanMoves) || sanMoves.length === 0) return null;
  if (nameIndex === null) nameIndex = buildNameIndex();

  const start = Math.min(sanMoves.length, longestName);
  for (let i = start; i >= 1; i--) {
    const hit = nameIndex.get(sanMoves.slice(0, i).join(' '));
    if (hit !== undefined) return { eco: hit.eco, name: hit.name };
  }
  return null;
}
