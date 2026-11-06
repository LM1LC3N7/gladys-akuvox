# TODO

## Decisions

- 2026-11-05 — Version 0.1.0 set by hand (package.json, lock, manifest, docker_image); the Release workflow
  owns it from now on. SDK `^0.16.0` (latest published on 2026-11-05).
- Reference: pylocal-akuvox 1.7.0 (Apache-2.0, commit 7b5e095) and homeassistant-local-akuvox 1.0.5
  (Apache-2.0, commit d9b6609), ported, nothing installed. Licenses read on 2026-11-05.
- Identity: the MAC address of `/api/system/info` (12 lowercase hex digits) makes the external ids; it is read
  at every reading cycle and right before every opening. An unreadable MAC is never "another device".
- Opening (`relay-<l>:open`): button/push, off by default (`allow_open`), option read again in `beforeSend`;
  `/api/relay/trig` with `mode: 0` (automatic close) and `delay` = `open_seconds` (1 to 30 s), `level` = the
  relay type; mode and type read in `/api/config/get` right before every opening (review r1, I1): mode 1,
  mode or type missing or unreadable, configuration API absent or refused = nothing sent. Never retried (a Digest 401 answered once is no retry: the 401
  did nothing), never queued beyond 4 per device, never replayed.
- No closing command: the device closes the relay by itself (automatic mode). The protective rules about a
  "close" therefore have nothing to apply to; a bistable relay is refused instead of being toggled.
- Relay state (`relay-<l>:state`): lock/state, read only, 1 at rest, 0 released. Integer states need the
  relay type; unknown type, unknown state (nothing published).
- Events by reading the logs (no inbound listener: no port opened, nothing to bound on the receiving side).
  An entry is an event only between two readings of one session closer than max(2 min, 3 intervals); the
  device's local time is never compared to ours. Empty answer is no baseline.
- Codes of the door log never read; the user name goes to scene events only.
- 401/403 on a log or the configuration (secondary): "not allowed" for that endpoint (1 min doubling to
  1 h), never a credentials refusal, the relays read on (review r1, I2).
- Own openings: their door-log entry is no event until two door readings after the send (30 min at most,
  8 marks), whatever the interval; an entry with a credential method is never taken for one (r1, I3, m3).
- Credentials refused (401 after one answered Digest challenge on identity, relays or the trigger): no
  automatic try; a configuration saved by the user tries once more (r1, m2); an 8-bit salted
  fingerprint per address in `/data/akuvox.json`, lifted by changed credentials or the test button. 403 is
  not a refusal (1 min doubling to 1 h). Digest configured and the device asks for Basic: nothing sent.
- `/data`: read bounded (2 s, 64 KB, regular file, no symbolic link); unreadable is never overwritten;
  writes never awaited by a command or a reading.
- Categories: `security`. No `keywords`, no `countries` (worldwide brand, sold in Europe).

## Later

- HTTPS with a pinned certificate (the devices have self-signed ones).
- Indoor monitors (IT83): opening through `/fcgi/do?action=OpenDoor` with its own credentials.
- Action URL events pushed by the device (a receiver with bounded size, connections and time).
- Confirm on a real device: log page order, call log timing, relay state values (strings, integers,
  `{ state }` objects), whether an opening through the API writes a door log entry.
- Mutation check of the guards: `memcap node scripts/mutants.mjs` (scripts/mutants.json).
