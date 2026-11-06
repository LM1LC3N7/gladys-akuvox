// -----------------------------------------------------------------------------
// One Akuvox device (one address): its readings, its identity, its relays,
// its logs, and the openings sent to it.
//
// Readings run one request at a time, in a cycle every `poll_interval`
// (measured from the start of the previous cycle): identity, relays, every
// 10 minutes the relay configuration, then the door and call logs. A log
// that fails or is not supported never holds the relays.
//
// A command never waits for a reading: it takes the device at once (the
// reading in flight is aborted, which is not a failure), and a reading that
// left before a command is never applied after it (`epoch`). Commands run
// one after the other per device, each within its own budget counted from
// its arrival; one that could not leave in time says "nothing sent".
//
// An opening is never sent twice by the integration: no retry, no replay
// after a restart. It is decided on the identity read right before it (the
// MAC address must be the one of the device the button belongs to), on the
// option read again right before the bytes leave, and on the relay
// configuration (a relay in manual mode is refused). It is reported
// confirmed only when the relay, at rest before, is read released after it.
// -----------------------------------------------------------------------------

import {
  PATHS,
  parseAnswer,
  parseInfo,
  parseLog,
  parseRelayConfig,
  parseRelayStatus,
  relayNumber,
  relayTriggered,
  triggerBody,
  doorSuccess,
  callType,
} from './akuvox.js';
import { LIMITS, TRIGGERS } from './constants.js';
import { LogTracker } from './events.js';
import { AkuvoxError } from './http.js';
import { T } from './i18n.js';

/** A reading that stepped back (a command came, the session stopped): not a failure. */
class Skip extends Error {}

/** The door log methods that name a person at the door. */
const CREDENTIAL = /pin|card|face|finger|qr|code|nfc|ble|bluetooth|plate|license|id ?card|rf/i;

/** A command refused or failed: its text for the status, its message for Gladys. */
export class CommandError extends Error {
  constructor(text, language) {
    super(text[language === 'en' ? 'en' : 'fr']);
    this.text = text;
  }
}

/** A refusal of the device: on identity or relays it stops the session, elsewhere it is "not read". */
const AUTH_KINDS = new Set(['refused', 'basic-only', 'forbidden']);

/** The next wait of an endpoint the device refuses: 1 min, doubled, at most 1 h. */
const nextWait = (wait, timings) =>
  Math.min(timings.forbiddenMax, wait === undefined ? timings.forbiddenFirst : wait * 2);

export class Session {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.digest = {};
    this.state = 'starting';
    this.identity = undefined;
    this.relays = new Map();
    this.relayConfig = undefined;
    this.configUnsupported = false;
    this.trackers = { door: new LogTracker(), call: new LogTracker() };
    this.logState = { door: 'ok', call: 'ok' };
    this.logRecheck = { door: 0, call: 0 };
    this.logWait = { door: undefined, call: undefined };
    this.configState = 'ok';
    this.configRecheck = 0;
    this.configWait = undefined;
    this.epoch = 0;
    this.currentRead = undefined;
    this.timer = undefined;
    this.followTimers = new Set();
    this.stopped = false;
    this.stopController = new AbortController();
    this.failures = 0;
    this.forbiddenWait = undefined;
    this.waiting = 0;
    this.commandChain = Promise.resolve();
    this.cmdVerifiedAt = undefined;
    this.cmdConfigAt = undefined;
    this.lastCommand = undefined;
    this.ownOpens = [];
    this.lastTest = -Infinity;
  }

  get mono() {
    return this.app.monotonic();
  }

  // --- lifecycle -----------------------------------------------------------

  begin(delay = 0) {
    this.schedule(delay);
  }

  schedule(delay) {
    if (this.stopped) return;
    this.app.timers.clearTimeout(this.timer);
    this.timer = this.app.timers.setTimeout(
      () => {
        this.timer = undefined;
        this.cycle().catch((err) =>
          this.app.logger.error(`Reading ${this.host.key} failed`, err?.message),
        );
      },
      Math.max(0, delay),
    );
  }

  stop() {
    this.stopped = true;
    this.app.timers.clearTimeout(this.timer);
    this.timer = undefined;
    for (const timer of this.followTimers) this.app.timers.clearTimeout(timer);
    this.followTimers.clear();
    this.currentRead?.abort();
    this.stopController.abort();
  }

  setState(state) {
    if (this.stopped) return;
    if (this.state !== state) {
      this.state = state;
      this.app.refreshStatus();
    }
  }

  // --- requests ------------------------------------------------------------

  requestOptions(extra) {
    const { auth, username, password } = this.app.config;
    return {
      host: this.host,
      auth: { mode: auth, username, password },
      session: this.digest,
      ...extra,
    };
  }

  /** A reading: steps back for any command, never applied after one. */
  async read(path, maxBody) {
    if (this.stopped || this.waiting > 0) throw new Skip();
    const epoch = this.epoch;
    const controller = new AbortController();
    this.currentRead = controller;
    try {
      const answer = await this.app.request(
        this.requestOptions({
          path,
          timeout: this.app.timings.readTimeout,
          signal: controller.signal,
          maxBody,
        }),
      );
      if (this.stopped || epoch !== this.epoch) throw new Skip();
      const data = parseAnswer(answer);
      this.app.credentialsAccepted(this);
      return data;
    } catch (err) {
      if (err instanceof Skip || this.stopped || epoch !== this.epoch || err?.kind === 'aborted') {
        throw new Skip();
      }
      throw err;
    } finally {
      if (this.currentRead === controller) this.currentRead = undefined;
    }
  }

  /** A request of a command: its own budget, aborted only by a stop. */
  async commandRequest(path, timeout, extra = {}) {
    const answer = await this.app.request(
      this.requestOptions({ path, timeout, signal: this.stopController.signal, ...extra }),
    );
    if (answer.status !== 401) this.app.credentialsAccepted(this);
    return answer;
  }

  // --- readings ------------------------------------------------------------

  async cycle() {
    if (this.stopped) return;
    const started = this.mono;
    let next;
    try {
      await this.readAll();
      this.failures = 0;
      this.forbiddenWait = undefined;
      next = started + this.app.config.pollMs - this.mono;
    } catch (err) {
      if (err instanceof Skip) {
        next = started + this.app.config.pollMs - this.mono;
      } else {
        next = this.readFailed(err);
      }
    }
    if (next !== undefined && !this.stopped && this.timer === undefined) this.schedule(next);
  }

  readFailed(err) {
    const kind = err?.kind ?? 'answer';
    if (kind === 'refused') {
      this.refused();
      return undefined;
    }
    if (kind === 'basic-only') {
      this.setState('basicOnly');
      return undefined;
    }
    if (kind === 'forbidden') {
      this.forbiddenWait = nextWait(this.forbiddenWait, this.app.timings);
      this.setState('forbidden');
      return this.forbiddenWait;
    }
    this.failures += 1;
    this.relays.clear();
    this.setState(kind === 'answer' || kind === 'unsupported' ? 'answer' : 'down');
    return Math.min(
      this.app.timings.downMax,
      this.app.config.pollMs * 2 ** Math.min(this.failures - 1, 10),
    );
  }

  refused() {
    this.app.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.relays.clear();
    this.setState('refused');
    this.app.credentialsRefused(this);
  }

  async readAll() {
    const info = parseInfo(await this.read(PATHS.info));
    this.applyIdentity(info);
    // The relay configuration first (it tells how to read an integer state),
    // every 10 minutes; never blocking: refused (401/403) or missing, it is
    // "not read" and asked again later, the relays are read anyway.
    const mono = this.mono;
    if (
      !this.configUnsupported &&
      this.configRecheck <= mono &&
      (!this.relayConfig || mono - this.relayConfig.at > this.app.timings.relayConfigEvery)
    ) {
      try {
        this.applyConfig(parseRelayConfig(await this.read(PATHS.config, LIMITS.maxConfigBody)));
        this.setConfigState('ok');
        this.configWait = undefined;
      } catch (err) {
        if (err instanceof Skip) throw err;
        if (AUTH_KINDS.has(err?.kind)) {
          this.configWait = nextWait(this.configWait, this.app.timings);
          this.configRecheck = this.mono + this.configWait;
          this.setConfigState('unauthorized');
        } else if (err?.kind === 'unsupported') {
          this.configUnsupported = true;
          this.setConfigState('unsupported');
        }
      }
    }
    const relays = parseRelayStatus(await this.read(PATHS.relays));
    this.applyRelays(relays);
    this.setState('ok');
    await this.readLog('door', PATHS.doorLog);
    await this.readLog('call', PATHS.callLog);
  }

  setConfigState(state) {
    if (this.configState !== state) {
      this.configState = state;
      this.app.refreshStatus();
    }
  }

  applyIdentity(info) {
    if (this.identity && this.identity.mac !== info.mac) {
      // Another device at this address: nothing of the previous one is kept.
      this.app.logger.warn(`Another device answers at ${this.host.key}`);
      this.relays.clear();
      this.relayConfig = undefined;
      this.configUnsupported = false;
      this.trackers.door.reset();
      this.trackers.call.reset();
      this.ownOpens = [];
      this.cmdVerifiedAt = undefined;
      this.cmdConfigAt = undefined;
    }
    const changed =
      !this.identity ||
      this.identity.mac !== info.mac ||
      this.identity.model !== info.model ||
      this.identity.firmware !== info.firmware;
    this.identity = info;
    if (changed) this.app.devicesChanged();
  }

  applyRelays(relays) {
    const before = [...this.relays.keys()].join();
    this.relays = relays;
    if ([...relays.keys()].join() !== before) this.app.devicesChanged();
    for (const letter of relays.keys()) {
      const triggered = this.triggered(letter);
      if (triggered !== undefined) this.app.publishRelay(this, letter, triggered ? 0 : 1);
    }
  }

  applyConfig(config) {
    const before = this.relayConfig;
    this.relayConfig = { ...config, at: this.mono };
    const names = (c) => (c ? [...c.relays.values()].map((r) => r.name).join() + c.location : '');
    if (names(before) !== names(this.relayConfig)) this.app.devicesChanged();
  }

  /**
   * Released (true), at rest (false), unknown. An integer state needs the
   * relay type; a device without a readable configuration API is read with
   * the default type (NO), as the reference integration does.
   */
  triggered(letter) {
    const type =
      this.relayConfig?.relays.get(letter)?.type ?? (this.configUnsupported ? 0 : undefined);
    return relayTriggered(this.relays.get(letter), type);
  }

  async readLog(kind, path) {
    const mono = this.mono;
    if (this.logRecheck[kind] > mono) return;
    let entries;
    try {
      entries = parseLog(await this.read(path), kind);
    } catch (err) {
      if (err instanceof Skip) throw err;
      if (AUTH_KINDS.has(err?.kind)) {
        // Refused for this log only: not read, asked again later.
        this.logWait[kind] = nextWait(this.logWait[kind], this.app.timings);
        this.logRecheck[kind] = this.mono + this.logWait[kind];
        this.logState[kind] = 'unauthorized';
      } else if (err?.kind === 'unsupported') {
        this.logState[kind] = 'unsupported';
        this.logRecheck[kind] = mono + 3_600_000;
      } else {
        this.logState[kind] = 'failed';
      }
      this.app.refreshStatus();
      return;
    }
    this.logWait[kind] = undefined;
    if (this.logState[kind] !== 'ok') {
      this.logState[kind] = 'ok';
      this.app.refreshStatus();
    }
    const gap = Math.max(
      this.app.timings.logGapMin,
      this.app.config.pollMs * this.app.timings.logGapFactor,
    );
    const { fresh, dropped } = this.trackers[kind].update(entries, this.mono, gap);
    if (dropped)
      this.app.logger.warn(
        `${dropped} ${kind} log entries of ${this.host.key} not published (too many at once)`,
      );
    for (const entry of fresh) {
      if (kind === 'door') this.doorEvent(entry);
      else this.callEvent(entry);
    }
    if (kind === 'door') {
      // An opening whose entry two door readings made after it did not show
      // never will: its mark goes (bounded in number and age as well).
      for (const own of this.ownOpens) if (own.at < mono) own.reads += 1;
      this.ownOpens = this.ownOpens.filter(
        (o) => o.reads < 2 && this.mono - o.at <= this.app.timings.ownOpenMax,
      );
    }
  }

  doorEvent(entry) {
    const success = doorSuccess(entry.status);
    if (success === undefined) return;
    if (success && this.consumeOwnOpen(entry)) return;
    this.app.sceneEvent(success ? TRIGGERS.OPENED : TRIGGERS.DENIED, {
      device: this.app.deviceId(this.identity.mac),
      relay: entry.relay || null,
      method: entry.method || null,
      user: entry.name || null,
    });
  }

  callEvent(entry) {
    this.app.sceneEvent(TRIGGERS.CALL, {
      device: this.app.deviceId(this.identity.mac),
      type: callType(entry.type),
      name: entry.name || null,
    });
  }

  /**
   * The door log entry an opening from Gladys made is not an event (a scene
   * opening the door on "door opened" would loop): one entry per opening, on
   * the relay it opened, until two door readings made after it went by
   * (whatever the interval). An entry with a credential (PIN, card, face...)
   * is someone at the door, never taken for it.
   */
  consumeOwnOpen(entry) {
    if (CREDENTIAL.test(entry.method)) return false;
    const index = this.ownOpens.findIndex(
      (o) => !entry.relay || entry.relay.includes(String(relayNumber(o.letter))),
    );
    if (index === -1) return false;
    this.ownOpens.splice(index, 1);
    return true;
  }

  markOwnOpen(letter, at) {
    this.ownOpens.push({ letter, at, reads: 0 });
    if (this.ownOpens.length > LIMITS.ownOpens) this.ownOpens.shift();
  }

  // --- commands ------------------------------------------------------------

  async open(letter, received) {
    const language = this.app.config.language;
    const refuse = (reason) => {
      throw new CommandError(T.notSent(letter.toUpperCase(), reason), language);
    };
    if (!this.app.config.allowOpen) refuse(T.openDisabled);
    if (this.state === 'refused') refuse(T.credentialsRefused);
    if (this.waiting >= LIMITS.commandQueue) refuse(T.queueFull);
    const deadline = received + this.app.timings.commandBudget;
    this.waiting += 1;
    this.epoch += 1;
    this.currentRead?.abort();
    const run = this.commandChain.then(() => this.runOpen(letter, deadline, received));
    this.commandChain = run.catch(() => {});
    try {
      return await run;
    } catch (err) {
      if (err instanceof CommandError) {
        this.lastCommand = err.text;
        this.app.refreshStatus();
        this.app.logger.info(
          `Opening ${this.host.key} relay ${letter.toUpperCase()}: ${err.text.en}`,
        );
      }
      throw err;
    } finally {
      this.waiting -= 1;
      if (this.waiting === 0 && !this.stopped && this.timer === undefined && this.state === 'ok') {
        // The cycle a command stopped is read again at its normal time.
        this.schedule(this.app.config.pollMs);
      }
    }
  }

  async runOpen(letter, deadline, received) {
    const language = this.app.config.language;
    const L = letter.toUpperCase();
    const fail = (text) => {
      throw new CommandError(text, language);
    };
    const notSent = (reason) => fail(T.notSent(L, reason));
    const remaining = () => deadline - this.mono;
    const step = () => Math.min(this.app.timings.commandStepTimeout, remaining());
    if (this.stopped) notSent(T.stopped);
    if (!this.app.config.allowOpen) notSent(T.openDisabled);
    if (this.state === 'refused') notSent(T.credentialsRefused);
    if (!this.identity) notSent(T.unknownDevice);
    if (remaining() < 100) notSent(T.tooLate);
    const reasonOf = (err) => {
      if (err?.kind === 'refused') {
        this.refused();
        return T.credentialsRefused;
      }
      if (err?.kind === 'withdrawn') return err.reason ?? T.openDisabled;
      if (err?.kind === 'aborted') return T.stopped;
      if (err?.kind === 'forbidden') return T.forbiddenReason;
      if (err?.kind === 'basic-only') return T.basicOnlyReason;
      if (err?.kind === 'answer' && !err.sent) return T.identityUnreadable;
      return T.unreachable;
    };

    // 1. Identity, read right before (shared with a command that read it after
    // this one arrived).
    if (this.cmdVerifiedAt === undefined || this.cmdVerifiedAt < received) {
      let info;
      try {
        info = parseInfo(parseAnswer(await this.commandRequest(PATHS.info, step())));
      } catch (err) {
        if (err?.kind === 'answer') notSent(T.identityUnreadable);
        notSent(reasonOf(err));
      }
      if (info.mac !== this.identity.mac) notSent(T.otherDevice);
      this.cmdVerifiedAt = this.mono;
    }

    // 2. The relay configuration, read right before (shared with a command
    // that read it after this one arrived): its mode must be automatic (0) and its type known; a
    // relay in manual mode, or one whose mode cannot be read, is never sent a
    // trigger (on a bistable relay it would stay released).
    if (this.cmdConfigAt === undefined || this.cmdConfigAt < received) {
      if (remaining() < 100) notSent(T.tooLate);
      try {
        this.applyConfig(
          parseRelayConfig(
            parseAnswer(
              await this.commandRequest(PATHS.config, step(), { maxBody: LIMITS.maxConfigBody }),
            ),
          ),
        );
        this.cmdConfigAt = this.mono;
      } catch (err) {
        if (err?.kind === 'aborted') notSent(T.stopped);
        if (err?.kind === 'unsupported') notSent(T.modeUnknown);
        if (AUTH_KINDS.has(err?.kind)) notSent(T.configForbidden);
        notSent(T.configNotRead);
      }
    }
    const relay = this.relayConfig?.relays.get(letter);
    if (relay?.mode === 1) notSent(T.manualRelay);
    if (relay?.mode !== 0 || (relay.type !== 0 && relay.type !== 1)) notSent(T.modeUnknown);
    if (!this.relays.has(letter)) notSent(T.unknownRelay);
    const before = this.triggered(letter);
    if (remaining() < 100) notSent(T.tooLate);

    // 3. The trigger: automatic close after the opening duration.
    const body = triggerBody({
      num: relayNumber(letter),
      level: relay.type,
      delay: this.app.config.openSeconds,
    });
    const sentAt = this.mono;
    let answer;
    try {
      answer = await this.commandRequest(PATHS.trigger, step(), {
        method: 'POST',
        json: body,
        beforeSend: () => {
          // Read again right before the bytes leave.
          if (this.stopped)
            return Object.assign(new AkuvoxError('Stopped', 'withdrawn'), { reason: T.stopped });
          if (!this.app.config.allowOpen) {
            return Object.assign(new AkuvoxError('Option off', 'withdrawn'), {
              reason: T.openDisabled,
            });
          }
          if (this.mono >= deadline) {
            return Object.assign(new AkuvoxError('Too late', 'withdrawn'), { reason: T.tooLate });
          }
          return true;
        },
      });
    } catch (err) {
      if (!err?.sent) notSent(reasonOf(err));
      this.markOwnOpen(letter, sentAt);
      this.followUp(letter, before);
      this.app.logger.info(`Opening ${this.host.key} relay ${L}: sent, no answer`);
      fail(T.sentUnconfirmed(L));
    }
    try {
      parseAnswer(answer);
    } catch {
      fail(T.rejectedByDevice(L));
    }
    this.markOwnOpen(letter, sentAt);
    this.app.logger.info(`Opening ${this.host.key} relay ${L}: accepted by the device`);

    // 4. Read back: confirmed only when released after being at rest.
    if (remaining() > 150) {
      try {
        const relays = parseRelayStatus(
          parseAnswer(await this.commandRequest(PATHS.relays, step())),
        );
        this.applyRelays(relays);
        if (before === false && this.triggered(letter) === true) {
          this.lastCommand = T.confirmed(L);
          this.app.refreshStatus();
          return this.lastCommand;
        }
      } catch {
        // Read back later.
      }
    }
    this.followUp(letter, before);
    fail(T.acceptedUnconfirmed(L));
  }

  /** Reads the relay again after an opening, to confirm it in the status. */
  followUp(letter, before) {
    for (const delay of this.app.timings.confirmReads) {
      const timer = this.app.timers.setTimeout(async () => {
        this.followTimers.delete(timer);
        try {
          const relays = parseRelayStatus(await this.read(PATHS.relays));
          this.applyRelays(relays);
          if (before === false && this.triggered(letter) === true) {
            const text = T.confirmed(letter.toUpperCase());
            if (this.lastCommand?.en !== text.en) {
              this.lastCommand = text;
              this.app.refreshStatus();
            }
          }
        } catch {
          // The next cycle reads it.
        }
      }, delay);
      this.followTimers.add(timer);
    }
  }

  // --- test button -----------------------------------------------------------

  async test() {
    const mono = this.mono;
    if (mono - this.lastTest < this.app.timings.testEvery && mono >= this.lastTest) {
      return T.testTooSoon(this.host.key);
    }
    this.lastTest = mono;
    try {
      const answer = await this.app.request(
        this.requestOptions({
          path: PATHS.info,
          timeout: this.app.timings.readTimeout,
          signal: this.stopController.signal,
        }),
      );
      const info = parseInfo(parseAnswer(answer));
      this.app.credentialsAccepted(this);
      if (this.state !== 'ok' || !this.identity) {
        this.failures = 0;
        this.forbiddenWait = undefined;
        this.schedule(0);
      }
      const mac = info.mac.match(/../g).join(':');
      return T.testOk(this.host.key, info.model, mac);
    } catch (err) {
      if (err?.kind === 'refused') {
        this.refused();
        return T.refused(this.host.key);
      }
      if (err?.kind === 'basic-only') {
        this.setState('basicOnly');
        return T.basicOnly(this.host.key);
      }
      if (err?.kind === 'forbidden') return T.forbidden(this.host.key);
      if (err?.kind === 'answer' || err?.kind === 'unsupported') return T.answer(this.host.key);
      return T.down(this.host.key);
    }
  }
}
