/*
 * harness.js — mini runner de tests sin dependencias.
 * Registra casos con test(name, fn), ofrece assert/assertEqual/assertClose
 * y run() ejecuta lo pendiente, imprime el resultado y termina con codigo 1
 * si algo falla. Pensado para que cada archivo de test llame a run() al final
 * y para que run-tests.js los importe en cadena.
 */

const pending = [];
let totalPassed = 0;
let totalFailed = 0;

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function test(name, fn) {
  pending.push({ name, fn });
}

export function assert(condition, message = 'la condición es falsa') {
  if (!condition) throw new AssertionError(message);
}

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString() + 'n';
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return '[' + value.map(show).join(', ') + ']';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function assertEqual(actual, expected, message = '') {
  if (!Object.is(actual, expected)) {
    const prefix = message ? message + ': ' : '';
    throw new AssertionError(prefix + 'se esperaba ' + show(expected) + ' y se obtuvo ' + show(actual));
  }
}

export function assertClose(actual, expected, epsilon = 1e-6, message = '') {
  const diff = Math.abs(actual - expected);
  if (!(diff <= epsilon)) {
    const prefix = message ? message + ': ' : '';
    throw new AssertionError(prefix + 'se esperaba ' + show(expected) + ' ±' + epsilon +
      ' y se obtuvo ' + show(actual) + ' (diferencia ' + diff + ')');
  }
}

export function assertThrows(fn, message = 'se esperaba una excepción') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new AssertionError(message);
}

export function assertDeepEqual(actual, expected, message = '') {
  const a = show(actual);
  const b = show(expected);
  if (a !== b) {
    const prefix = message ? message + ': ' : '';
    throw new AssertionError(prefix + 'se esperaba ' + b + ' y se obtuvo ' + a);
  }
}

export function run(title = '') {
  const batch = pending.splice(0, pending.length);
  if (title) process.stdout.write('\n=== ' + title + ' ===\n');
  let passed = 0;
  const failures = [];
  for (let i = 0; i < batch.length; i++) {
    const { name, fn } = batch[i];
    const started = Date.now();
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new AssertionError('los tests deben ser síncronos');
      }
      passed++;
      const ms = Date.now() - started;
      process.stdout.write('  ok   ' + name + (ms > 50 ? '  (' + ms + ' ms)' : '') + '\n');
    } catch (err) {
      failures.push({ name, err });
      process.stdout.write('  FALLA ' + name + '\n         ' + (err && err.message ? err.message : String(err)) + '\n');
    }
  }
  totalPassed += passed;
  totalFailed += failures.length;
  process.stdout.write('  ' + passed + '/' + batch.length + ' correctos\n');
  if (failures.length > 0) {
    process.stdout.write('\n' + failures.length + ' test(s) fallaron.\n');
    for (const failure of failures) {
      if (failure.err && failure.err.stack && !(failure.err instanceof AssertionError)) {
        process.stdout.write(failure.err.stack + '\n');
      }
    }
    process.exit(1);
  }
  return { passed, failed: failures.length, total: batch.length };
}

export function summary() {
  return { passed: totalPassed, failed: totalFailed };
}
