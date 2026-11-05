// -----------------------------------------------------------------------------
// JSON from the network or the disk, parsed without the keys that could reach
// an object prototype later (`__proto__`, `constructor`, `prototype`). The
// device answers are only read by fixed keys, never merged into an object, but
// such a key is dropped at the source anyway. (From gladys-comelit.)
// -----------------------------------------------------------------------------

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function safeJson(text) {
  return JSON.parse(text, (key, value) => (FORBIDDEN.has(key) ? undefined : value));
}

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An own property of a parsed object, never one of its prototype. */
export const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
