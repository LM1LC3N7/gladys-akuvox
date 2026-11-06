// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. (From gladys-remootio.)
// -----------------------------------------------------------------------------

import { ACTIONS, TIMINGS } from './constants.js';
import { T } from './i18n.js';

/**
 * At every (re)connection to Gladys: the configuration, then the app. A
 * configuration that cannot be read is asked again (5 s, 15 s, 30 s, then
 * every minute, without end) with a status: the integration never stays dead.
 */
export function startOnConnect(gladys, app, logger, timers = globalThis) {
  let attempt = 0;
  let timer;
  let run = 0;
  const tryStart = async (current) => {
    try {
      const config = await gladys.getConfig();
      if (current !== run) return;
      attempt = 0;
      await app.start(config);
    } catch (err) {
      if (current !== run) return;
      logger?.error('Start failed', err?.message);
      const wait = TIMINGS.configRetry[Math.min(attempt, TIMINGS.configRetry.length - 1)];
      attempt += 1;
      gladys.setConnectionStatus(false, T.configUnreadable(wait)).catch(() => {});
      timers.clearTimeout(timer);
      timer = timers.setTimeout(() => tryStart(current), wait);
    }
  };
  return () => {
    run += 1;
    timers.clearTimeout(timer);
    return tryStart(run);
  };
}

export function registerHandlers(gladys, app, logger, timers = globalThis) {
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onConfigUpdated((config) => app.start(config, { saved: true }));
  const onConnected = startOnConnect(gladys, app, logger, timers);
  gladys.on('connected', () => onConnected());
}
