// -----------------------------------------------------------------------------
// The HTTP API of the Akuvox door phones and access controllers, ported from
// pylocal-akuvox 1.7.0 (Apache-2.0, see THIRD_PARTY_NOTICES.md):
//   GET  /api/system/info   identity: model, MAC, firmware
//   GET  /api/relay/status  { RelayA: "open"|"closed"|0|1, ... }
//   GET  /api/config/get    the configuration (autop keys); only the relay
//                           keys and the location are kept, never anything else
//   GET  /api/doorlog/get   door log { item: [{ ID, Date, Time, Name, Code, Type, Relay, Status }] }
//   GET  /api/calllog/get   call log { item: [{ ID, Date, Time, Name, Type, LocalIdentity, Num }] }
//   POST /api/relay/trig    { target: "relay", action: "trig", data: { num, mode, level, delay } }
// Every answer is an envelope { retcode, message, data }: a negative retcode
// is a device error, "api unsupported" an endpoint this firmware lacks.
// Pure functions only: no I/O here.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';
import { AkuvoxError } from './http.js';
import { isObject, own, safeJson } from './json.js';

export const PATHS = Object.freeze({
  info: '/api/system/info',
  relays: '/api/relay/status',
  config: '/api/config/get',
  doorLog: '/api/doorlog/get',
  callLog: '/api/calllog/get',
  trigger: '/api/relay/trig',
});

const UNSUPPORTED = ['api unsupported', 'unsupported action', 'unsupport action'];

/** The `data` of an answer, checked (status and envelope). */
export function parseAnswer({ status, text }) {
  if (status === 403) throw new AkuvoxError('Forbidden', 'forbidden', { sent: true, status });
  if (status === 404) throw new AkuvoxError('Not found', 'unsupported', { sent: true, status });
  if (status >= 500) throw new AkuvoxError(`HTTP ${status}`, 'device', { sent: true, status });
  if (status < 200 || status >= 300) {
    throw new AkuvoxError(`HTTP ${status}`, 'answer', { sent: true, status });
  }
  let body;
  try {
    body = safeJson(text);
  } catch {
    throw new AkuvoxError('Not JSON', 'answer', { sent: true, status });
  }
  const retcode = own(body, 'retcode');
  if (!Number.isInteger(retcode)) {
    throw new AkuvoxError('No envelope', 'answer', { sent: true, status });
  }
  const message = String(own(body, 'message') ?? '').toLowerCase();
  if (UNSUPPORTED.some((marker) => message.includes(marker))) {
    throw new AkuvoxError('Unsupported', 'unsupported', { sent: true, status });
  }
  if (retcode < 0) throw new AkuvoxError('Device error', 'device', { sent: true, status });
  const data = own(body, 'data');
  return isObject(data) ? data : {};
}

/** "AA:BB:CC:DD:EE:FF" (or without separators) -> "aabbccddeeff", undefined otherwise. */
export function normalizeMac(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^[0-9A-Fa-f]{2}([:-]?)(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}$/.test(text)) return undefined;
  const mac = text.replace(/[:-]/g, '').toLowerCase();
  if (mac === '000000000000' || mac === 'ffffffffffff') return undefined;
  // A multicast MAC is never the address of a device.
  if (parseInt(mac.slice(0, 2), 16) & 1) return undefined;
  return mac;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A text of the device, made safe to publish: no control character, bounded. */
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(CONTROL, ' ').trim().slice(0, max);
}

/** /api/system/info -> { model, mac, firmware } ; throws when the MAC is unreadable. */
export function parseInfo(data) {
  const status = own(data, 'Status');
  const mac = normalizeMac(own(status, 'MAC'));
  if (!mac) throw new AkuvoxError('No readable MAC address', 'answer', { sent: true });
  return {
    mac,
    model: cleanText(own(status, 'Model'), 32) || 'Akuvox',
    firmware: cleanText(own(status, 'FirmwareVersion'), 32),
  };
}

const LETTERS = ['a', 'b', 'c', 'd'];
export const relayNumber = (letter) => LETTERS.indexOf(letter) + 1;

/**
 * /api/relay/status -> Map letter -> raw value ("open", "closed", 0, 1...).
 * Only RelayA to RelayD.
 */
export function parseRelayStatus(data) {
  const relays = new Map();
  for (const letter of LETTERS) {
    const value = own(data, `Relay${letter.toUpperCase()}`);
    if (value !== undefined) relays.set(letter, value);
  }
  return relays;
}

/**
 * Is the relay triggered (door released)? true, false, or undefined (unknown).
 * Strings: "open"/"active" triggered, "closed"/"inactive" at rest. Integers
 * depend on the relay type (0 NO: 1 triggered; 1 NC: 0 triggered), as the
 * Home Assistant integration reads them; an unknown type leaves them unknown.
 */
export function relayTriggered(value, type) {
  // Some firmwares wrap it: { "state": 1 } (as the reference reads it).
  if (isObject(value)) return relayTriggered(own(value, 'state'), type);
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'open' || text === 'active') return true;
    if (text === 'closed' || text === 'inactive') return false;
    if (text === '0' || text === '1') return relayTriggered(Number(text), type);
    return undefined;
  }
  if (value !== 0 && value !== 1) return undefined;
  if (type === 0) return value === 1;
  if (type === 1) return value === 0;
  return undefined;
}

const configInt = (data, key, allowed) => {
  const value = own(data, key);
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,2}$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return allowed.includes(n) ? n : undefined;
};

const PREFIX = 'Config.DoorSetting.RELAY.';

/**
 * /api/config/get -> { location, relays: Map letter -> { mode, type, name } }.
 * mode: 0 automatic close, 1 manual (bistable); type: 0 NO, 1 NC; undefined
 * when absent or unreadable. Nothing else of the configuration is kept (it
 * holds the device's own passwords).
 */
export function parseRelayConfig(data) {
  const relays = new Map();
  for (const letter of LETTERS) {
    const L = letter.toUpperCase();
    relays.set(letter, {
      mode: configInt(data, `${PREFIX}Relay${L}Mode`, [0, 1]),
      type: configInt(data, `${PREFIX}Relay${L}Type`, [0, 1]),
      name: cleanText(own(data, `${PREFIX}Name${L}`), 32),
    });
  }
  return {
    location: cleanText(own(data, 'Config.DoorSetting.DEVICENODE.Location'), 48),
    relays,
  };
}

/** The body of a relay trigger: automatic close after `delay` seconds. */
export function triggerBody({ num, level, delay }) {
  return { target: 'relay', action: 'trig', data: { num, mode: 0, level, delay } };
}

/**
 * A log answer -> entries [{ id (number), ... }], at most LIMITS.logItems,
 * the ones without a numeric ID dropped. The PIN or card code of a door log
 * entry is never read.
 */
export function parseLog(data, kind) {
  const items = own(data, 'item');
  if (!Array.isArray(items)) return [];
  const entries = [];
  for (const item of items.slice(0, LIMITS.logItems)) {
    const raw = own(item, 'ID');
    const text = typeof raw === 'number' ? String(raw) : raw;
    if (typeof text !== 'string' || !/^\d{1,12}$/.test(text.trim())) continue;
    const id = Number(text.trim());
    if (!Number.isSafeInteger(id)) continue;
    if (kind === 'door') {
      entries.push({
        id,
        name: cleanText(own(item, 'Name')),
        method: cleanText(own(item, 'Type'), 32),
        relay: cleanText(own(item, 'Relay'), 8),
        status: cleanText(own(item, 'Status'), 16),
      });
    } else {
      entries.push({
        id,
        name: cleanText(own(item, 'Name')),
        type: cleanText(own(item, 'Type'), 16),
      });
    }
  }
  return entries;
}

/** "Succ", "Success", "OK"... -> true ; "Failed", "Fail"... -> false ; else undefined. */
export function doorSuccess(status) {
  const text = String(status ?? '')
    .trim()
    .toLowerCase();
  if (/^(succ|success|successful|succeeded|ok|pass|passed|granted)$/.test(text)) return true;
  if (/^(fail|failed|failure|denied|refused|invalid|error)$/.test(text)) return false;
  return undefined;
}

/** Call type -> dialed | received | missed | other. */
export function callType(type) {
  const text = String(type ?? '')
    .trim()
    .toLowerCase();
  if (/^(dialed|dialled|outgoing|out)$/.test(text)) return 'dialed';
  if (/^(received|incoming|answered|in)$/.test(text)) return 'received';
  if (/^(missed|miss)$/.test(text)) return 'missed';
  return 'other';
}
