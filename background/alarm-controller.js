// @ts-check

export const ALARM_NAMES = Object.freeze({
  REFRESH: 'rss-refresh-tick',
  MAINTENANCE: 'rss-maintenance-tick',
});

/**
 * @typedef {object} BrowserAlarmApi
 * @property {{create(name: string, info: {periodInMinutes: number}): Promise<void>}} alarms
 *
 * @typedef {object} RefreshService
 * @property {() => Promise<unknown>} refreshDueFeeds
 * @property {() => Promise<unknown>} runMaintenance
 */

/**
 * @param {BrowserAlarmApi} browserApi
 */
export async function ensureAlarms(browserApi) {
  await browserApi.alarms.create(ALARM_NAMES.REFRESH, { periodInMinutes: 5 });
  await browserApi.alarms.create(ALARM_NAMES.MAINTENANCE, { periodInMinutes: 60 });
}

/**
 * @param {RefreshService} refreshService
 * @param {BrowserAlarmApi} browserApi
 */
export function createAlarmController(refreshService, browserApi) {
  return {
    handleInstalled: () => ensureAlarms(browserApi),
    handleStartup: () => ensureAlarms(browserApi),
    /**
     * @param {{name: string}} alarm
     */
    async handleAlarm(alarm) {
      if (alarm.name === ALARM_NAMES.REFRESH) {
        await refreshService.refreshDueFeeds();
        return;
      }
      if (alarm.name === ALARM_NAMES.MAINTENANCE) await refreshService.runMaintenance();
    },
  };
}
