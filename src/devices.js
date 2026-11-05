// -----------------------------------------------------------------------------
// Akuvox devices -> Gladys devices (pure).
//
// External ids (forever): `ext:<selector>:akuvox:<mac>` for the device, the MAC
// address read from /api/system/info (12 lowercase hex digits); per relay
// (letter a to d):
//   - `relay-<l>:state`: lock/state, READ ONLY (1 at rest, 0 released);
//   - `relay-<l>:open`: button/push, the opening (off by default).
// The opening is a push button, never a switch nor a lock: a "turn
// everything off" or a "lock everything" can never release a door. There is
// no closing command: the relay closes by itself after the opening duration
// (automatic close, the only mode this integration triggers).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURE_RE, featureKey } from './constants.js';
import { T as TEXT, relayLabel } from './i18n.js';

const STATE = {
  category: C.LOCK,
  type: T.LOCK.STATE,
  min: 0,
  max: 3,
  read_only: true,
  has_feedback: true,
  keep_history: true,
};

const BUTTON = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The feature id of a device -> { mac, letter, kind }, or undefined. */
export function parseFeatureId(gladys, externalId) {
  if (typeof externalId !== 'string') return undefined;
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (!externalId.startsWith(prefix)) return undefined;
  const rest = externalId.slice(prefix.length);
  const match = /^([0-9a-f]{12}):(.+)$/.exec(rest);
  if (!match) return undefined;
  const feature = FEATURE_RE.exec(match[2]);
  if (!feature) return undefined;
  return { mac: match[1], letter: feature[1], kind: feature[2] };
}

/**
 * One Gladys device. `relays`: the letters seen on the device; `names`:
 * letter -> relay name from its configuration; `existing`: the device as
 * Gladys has it (its features are kept, a relay not seen this time is
 * never removed from Discovery).
 */
export function buildDevice(
  gladys,
  { mac, model, firmware, host, location, relays, names },
  language,
  existing,
) {
  const ids = gladys.externalIds(DEVICE_TYPE, mac);
  const lang = language === 'en' ? 'en' : 'fr';
  const letters = new Set(relays);
  for (const feature of existing?.features ?? []) {
    const parsed = parseFeatureId(gladys, feature.external_id);
    if (parsed?.mac === mac) letters.add(parsed.letter);
  }
  const features = [];
  for (const letter of [...letters].sort()) {
    const label = relayLabel(letter, names?.get(letter));
    features.push(
      {
        ...STATE,
        name: TEXT.relayState[lang](label),
        external_id: ids.feature(featureKey(letter, 'state')),
      },
      {
        ...BUTTON,
        name: TEXT.relayOpen[lang](label),
        external_id: ids.feature(featureKey(letter, 'open')),
      },
    );
  }
  const name = [TEXT.deviceName[lang], model, location].filter(Boolean).join(' ');
  return {
    name: existing?.name ?? name,
    external_id: ids.device,
    features,
    params: [
      { name: 'address', value: host },
      { name: 'model', value: model },
      { name: 'firmware', value: firmware || '-' },
    ],
  };
}
