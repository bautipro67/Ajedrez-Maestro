/**
 * run-tests.js — ejecuta todas las suites de test/ en un solo proceso.
 * Descubre los *.test.js del directorio y los importa en un orden estable
 * (primero las reglas, luego lo que se apoya en ellas). Cada suite llama a
 * run() al importarse, asi que basta con encadenar los imports y resumir.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summary } from './harness.js';

const ORDER = ['perft', 'rules', 'edge', 'engine', 'book', 'bots', 'elo', 'tournament', 'screens', 'ws', 'server'];

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((name) => name.endsWith('.test.js'));

function rank(name) {
  const index = ORDER.indexOf(name.replace(/\.test\.js$/, ''));
  return index === -1 ? ORDER.length : index;
}

files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

const started = Date.now();
for (const file of files) {
  await import(pathToFileURL(path.join(dir, file)).href);
}

const { passed, failed } = summary();
const seconds = ((Date.now() - started) / 1000).toFixed(1);

process.stdout.write('\n=== total ===\n');
process.stdout.write('  ' + files.length + ' suites, ' + (passed + failed) + ' tests, ' +
  passed + ' correctos, ' + failed + ' fallidos, ' + seconds + ' s\n');

process.exit(failed > 0 ? 1 : 0);
