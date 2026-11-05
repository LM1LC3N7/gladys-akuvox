// -----------------------------------------------------------------------------
// AkuvoxApp: the configuration, one Session per address (src/session.js),
// Discovery, the states and scene events published to Gladys under their rate
// limits, the status of the Configuration screen, the refused credentials kept
// in /data (src/store.js).
//
// Clocks are injected: `monotonic` for every decision (deadlines, intervals,
// windows, limits), `now` for /data dates only; `timers` for every timer.
// -----------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';
import { normalizeConfig } from './config.js';
import { DEVICE_TYPE, LIMITS, TIMINGS, featureKey } from './constants.js';
import { buildDevice, parseFeatureId } from './devices.js';
import { RateLimiter } from './events.js';
import { request as httpRequest } from './http.js';
import { T } from './i18n.js';
import { CommandError, Session } from './session.js';
import { FileStore, emptyData, fingerprint } from './store.js';

const credentialsOf = (config) => `${config.auth}\n${config.username}\n${config.password}`;

export class AkuvoxApp {
  constructor({
    gladys,
    logger = console,
    store = new FileStore(),
    timers = globalThis,
    now = Date.now,
    monotonic = () => performance.now(),
    timings = {},
    request = httpRequest,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.timers = timers;
    this.now = now;
    this.monotonic = monotonic;
    this.timings = { ...TIMINGS, ...timings };
    this.request = request;
    this.sessions = new Map();
    this.config = undefined;
    this.data = undefined;
    this.storeState = undefined;
    this.chain = Promise.resolve();
    this.stopped = false;
    this.lastStatus = undefined;
    this.statusQueued = false;
    this.discoveryQueued = false;
    this.published = new Map();
    this.stateLimiter = new RateLimiter(LIMITS.statesPerMinute);
    this.eventLimiter = new RateLimiter(LIMITS.eventsPerMinute);
  }

  // --- lifecycle -------------------------------------------------------------

  /** A configuration (start, save, reconnection): applied one at a time, the last one wins. */
  start(raw) {
    const run = this.chain.then(() => this.apply(raw));
    this.chain = run.catch(() => {});
    return run;
  }

  async apply(raw) {
    if (this.stopped) return;
    if (!this.data) {
      const { data, state } = await this.store.load();
      if (this.stopped) return;
      this.data = data ?? emptyData();
      this.storeState = state;
    }
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.config = next;
    const credentialsChanged = previous && credentialsOf(previous) !== credentialsOf(next);
    if (credentialsChanged && Object.keys(this.data.refused).length) {
      // New credentials: tried again everywhere.
      this.data.refused = {};
      this.persist();
    }
    const wanted = new Map(
      next.problem && next.problem !== 'tooManyHosts' ? [] : next.hosts.map((h) => [h.key, h]),
    );
    for (const [key, session] of this.sessions) {
      if (!wanted.has(key) || credentialsChanged) {
        session.stop();
        this.sessions.delete(key);
      }
    }
    for (const [key, host] of wanted) {
      if (this.sessions.has(key)) continue;
      const session = new Session(this, host);
      this.sessions.set(key, session);
      if (this.isRefused(session)) session.state = 'refused';
      else session.begin(0);
    }
    // Fresh states only: what Gladys had is published again from the next readings.
    this.published.clear();
    this.gladys.forgetPublishedStates?.();
    this.lastStatus = undefined;
    this.refreshStatus();
    await this.scan();
  }

  async stop() {
    this.stopped = true;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }

  // --- refused credentials (/data) --------------------------------------------

  fingerprintOf(session) {
    return fingerprint(this.data.salt, session.host.key, this.config);
  }

  isRefused(session) {
    return this.data.refused[session.host.key]?.fp === this.fingerprintOf(session);
  }

  credentialsRefused(session) {
    if (this.stopped || this.sessions.get(session.host.key) !== session) return;
    this.logger.warn(
      `Credentials refused by ${session.host.key}: no more tries until changed or tested`,
    );
    this.data.refused[session.host.key] = { fp: this.fingerprintOf(session), at: this.now() };
    this.persist();
  }

  credentialsAccepted(session) {
    if (this.stopped || !this.data.refused[session.host.key]) return;
    if (this.sessions.get(session.host.key) !== session) return;
    delete this.data.refused[session.host.key];
    this.persist();
  }

  /** Never awaited: a slow disk holds nothing. An unreadable file is never overwritten. */
  persist() {
    if (this.storeState === 'unreadable') return;
    Promise.resolve(this.store.save(structuredClone(this.data))).then(
      (ok) => {
        if (ok === false) this.logger.warn('/data could not be written');
      },
      () => this.logger.warn('/data could not be written'),
    );
  }

  // --- Gladys ------------------------------------------------------------------

  deviceId(mac) {
    return this.gladys.externalIds(DEVICE_TYPE, mac).device;
  }

  /** The devices read in this session, as Discovery shows them. */
  async scan() {
    if (this.stopped || !this.config) return;
    const devices = [];
    for (const session of this.sessions.values()) {
      if (!session.identity) continue;
      const { mac, model, firmware } = session.identity;
      const existing = (this.gladys.devices ?? []).find(
        (d) => d.external_id === this.deviceId(mac),
      );
      const names = new Map(
        [...(session.relayConfig?.relays ?? new Map())].map(([letter, relay]) => [
          letter,
          relay.name,
        ]),
      );
      devices.push(
        buildDevice(
          this.gladys,
          {
            mac,
            model,
            firmware,
            host: session.host.key,
            location: session.relayConfig?.location,
            relays: [...session.relays.keys()],
            names,
          },
          this.config.language,
          existing,
        ),
      );
    }
    // The same device behind two addresses is listed once.
    const unique = [...new Map(devices.map((d) => [d.external_id, d])).values()];
    try {
      await this.gladys.publishDiscoveredDevices(unique);
    } catch (err) {
      this.logger.warn('Discovery not published', err?.message);
    }
  }

  devicesChanged() {
    if (this.discoveryQueued) return;
    this.discoveryQueued = true;
    queueMicrotask(() => {
      this.discoveryQueued = false;
      this.scan();
    });
  }

  async deviceCreated(device) {
    // Its states are published again from the next reading (never a cached value).
    for (const key of [...this.published.keys()]) {
      if (key.startsWith(`${device?.external_id}:`)) this.published.delete(key);
    }
  }

  async deviceDeleted(device) {
    await this.deviceCreated(device);
  }

  publishRelay(session, letter, value) {
    if (this.stopped || this.sessions.get(session.host.key) !== session || !session.identity)
      return;
    const id = this.gladys
      .externalIds(DEVICE_TYPE, session.identity.mac)
      .feature(featureKey(letter, 'state'));
    if (this.published.get(id) === value) return;
    if (!this.stateLimiter.take(this.monotonic())) return;
    this.published.set(id, value);
    this.gladys
      .publishChangedStates([{ device_feature_external_id: id, state: value }])
      .catch((err) => {
        this.published.delete(id);
        this.logger.warn('State not published', err?.message);
      });
  }

  sceneEvent(key, data) {
    if (this.stopped) return;
    if (!this.eventLimiter.take(this.monotonic())) {
      this.logger.warn(
        `Event ${key} not published: more than ${LIMITS.eventsPerMinute} per minute`,
      );
      return;
    }
    this.gladys
      .publishSceneEvent(key, data)
      .catch((err) => this.logger.warn(`Event ${key} not published`, err?.message));
  }

  // --- commands ----------------------------------------------------------------

  async setValue(_device, feature, value) {
    const received = this.monotonic();
    const language = this.config?.language;
    const refuse = (reason) => {
      throw new CommandError(reason, language);
    };
    if (!this.config) refuse(T.configLoading);
    const target = parseFeatureId(this.gladys, feature?.external_id);
    if (!target) refuse(T.unknownDevice);
    if (target.kind !== 'open') refuse(T.notButton);
    if (value !== 1 && value !== '1') refuse(T.badValue);
    const session = [...this.sessions.values()].find((s) => s.identity?.mac === target.mac);
    if (!session) refuse(T.unknownDevice);
    const text = await session.open(target.letter, received);
    return text[language === 'en' ? 'en' : 'fr'];
  }

  /** The test button: every address once (each at most every 5 s). */
  async testConnection() {
    if (!this.config) return T.configLoading;
    if (this.config.problem && this.config.problem !== 'tooManyHosts')
      return T[this.config.problem];
    const results = await Promise.all([...this.sessions.values()].map((s) => s.test()));
    this.refreshStatus();
    if (!results.length) return T.testNoHost;
    return {
      fr: results.map((r) => r.fr).join(' · '),
      en: results.map((r) => r.en).join(' · '),
    };
  }

  // --- status ------------------------------------------------------------------

  statusLine(session) {
    const key = session.host.key;
    let line;
    switch (session.state) {
      case 'ok': {
        line = T.ok(key, session.identity?.model ?? 'Akuvox', session.relays.size);
        const extras = [];
        if (session.logState.door !== 'ok' || session.logState.call !== 'ok') {
          const unsupported =
            session.logState.door === 'unsupported' && session.logState.call === 'unsupported';
          extras.push(unsupported ? T.noLogs : T.logsUnread);
        }
        if (session.lastCommand) extras.push(T.lastCommand(session.lastCommand));
        if (extras.length) {
          line = {
            fr: `${line.fr} (${extras.map((e) => e.fr).join(', ')})`,
            en: `${line.en} (${extras.map((e) => e.en).join(', ')})`,
          };
        }
        break;
      }
      case 'refused':
        line = T.refused(key);
        break;
      case 'forbidden':
        line = T.forbidden(key);
        break;
      case 'basicOnly':
        line = T.basicOnly(key);
        break;
      case 'answer':
        line = T.answer(key);
        break;
      case 'down':
        line = T.down(key);
        break;
      default:
        line = T.starting(key);
    }
    return line;
  }

  refreshStatus() {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      this.publishStatus();
    });
  }

  publishStatus() {
    if (this.stopped || !this.config) return;
    const config = this.config;
    let connected = false;
    let parts = [];
    if (config.problem && config.problem !== 'tooManyHosts') {
      parts.push(T[config.problem]);
    } else {
      if (config.problem) parts.push(T[config.problem]);
      for (const session of this.sessions.values()) {
        if (session.state === 'ok') connected = true;
        parts.push(this.statusLine(session));
      }
      if (!config.allowOpen) parts.push(T.openOff);
    }
    if (config.invalid) parts.push(T.ignored(config.invalid));
    if (this.storeState === 'unreadable') parts.push(T.dataUnreadable);
    parts = parts.filter(Boolean);
    const cut = (text) =>
      text.length > LIMITS.status ? `${text.slice(0, LIMITS.status - 1)}…` : text;
    const message = {
      fr: cut(parts.map((p) => p.fr).join(' · ')),
      en: cut(parts.map((p) => p.en).join(' · ')),
    };
    const key = `${connected}\n${message.fr}\n${message.en}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.gladys.setConnectionStatus(connected, message).catch(() => {
      this.lastStatus = undefined;
    });
  }
}
