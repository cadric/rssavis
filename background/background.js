// @ts-check

import { MESSAGE_TYPES } from '../domain/message-types.js';
import { createAlarmController, ensureAlarms } from './alarm-controller.js';
import { createArticleCommandHandlers } from './article-commands.js';
import { createBootstrapCommandHandlers } from './bootstrap-commands.js';
import { createCategoryCommandHandlers } from './category-commands.js';
import { createBackgroundDatabaseOptions } from './db-options.js';
import { createReaderActionController } from './action-controller.js';
import { createCommandRouter, createMessageDispatcher } from './command-router.js';
import { createFeedCommandHandlers } from './feed-commands.js';
import { createIconResolver } from './icon-resolver.js';
import { createSettingsCommandHandlers } from './settings-commands.js';
import { createStorageCommandHandlers } from './storage-commands.js';
import { createOpmlCommandHandlers } from './opml-service.js';
import { createTrustedResourceCommandHandlers } from './trusted-resource-commands.js';
import { createPermissionController } from './permission-controller.js';
import { createRefreshService } from './refresh-service.js';
import { createActionBadgeController } from './action-badge-controller.js';
import { createCommittedChangePublisher } from './change-events.js';
import { readMainStreamUnreadCount } from './system-stats.js';
import { SETTINGS_EFFECTS } from '../shared/settings-effects.js';

/**
 * @typedef {object} BackgroundBrowser
 * @property {{getMessage(key: string, substitutions?: string | string[]): string, getUILanguage(): string}} i18n
 * @property {{sendMessage(message: unknown): Promise<unknown>, getURL(path: string): string, getManifest(): {version?: string}, getContexts(filter: Record<string, unknown>): Promise<import('./action-controller.js').ExtensionContext[]>, onMessage: ListenerTarget, onInstalled: ListenerTarget, onStartup: ListenerTarget}} runtime
 * @property {{onClicked: ListenerTarget, setBadgeText?: (details: {text: string}) => Promise<void>, setTitle?: (details: {title: string}) => Promise<void>}} action
 * @property {{create(name: string, info: {periodInMinutes: number}): Promise<void>, onAlarm: ListenerTarget}} alarms
 * @property {{contains(permissions: {origins: string[]}): Promise<boolean>, getAll(): Promise<{origins?: string[], permissions?: string[]}>, onAdded: ListenerTarget, onRemoved: ListenerTarget}} permissions
 * @property {{local: import('../data/settings-repository.js').StorageArea, session?: import('./reader-context-activity.js').StorageArea}} storage
 * @property {{create(properties: {url: string, active?: boolean}): Promise<{id?: number, windowId?: number}>, update(tabId: number, properties: {active?: boolean, url?: string}): Promise<unknown>}} tabs
 * @property {{update(windowId: number, properties: {focused: boolean}): Promise<unknown>}} windows
 */

/**
 * @typedef {object} ListenerTarget
 * @property {(listener: (...args: never[]) => unknown) => void} addListener
 */

const browser = /** @type {{browser: BackgroundBrowser}} */ (/** @type {unknown} */ (globalThis)).browser;

const databaseOptions = createBackgroundDatabaseOptions(browser);
const permissionController = createPermissionController(databaseOptions, browser);
const iconResolver = createIconResolver(databaseOptions, browser);
const actionBadgeController = createActionBadgeController({
  action: browser.action,
  i18n: browser.i18n,
  readUnreadCount: () => readMainStreamUnreadCount(databaseOptions),
  reportError: reportBackgroundError,
});
const changePublisher = createCommittedChangePublisher(browser, {
  onCommittedChange: () => void actionBadgeController.sync(),
});
const refreshService = createRefreshService(databaseOptions, {
  browserApi: browser,
  permissionController,
  resolveIcon: (feedId) => iconResolver.resolveIcon(feedId),
  storageArea: browser.storage.local,
  changePublisher,
});
const alarmController = createAlarmController(refreshService, browser);
const readerActionController = createReaderActionController(browser);

const router = createCommandRouter({
  ...createBootstrapCommandHandlers(databaseOptions),
  ...createTrustedResourceCommandHandlers(browser),
  [MESSAGE_TYPES.READER_CONTEXT_ACTIVE]: (payload, context) =>
    readerActionController.recordReaderContextActive(payload, context),
  [MESSAGE_TYPES.READER_OPEN_OR_FOCUS]: () => readerActionController.openOrFocusReader(),
  ...createArticleCommandHandlers(databaseOptions, browser, changePublisher),
  ...createCategoryCommandHandlers(databaseOptions, browser, changePublisher),
  ...createFeedCommandHandlers(databaseOptions, browser, refreshService, changePublisher),
  ...createOpmlCommandHandlers(databaseOptions, browser, refreshService, changePublisher),
  ...createSettingsCommandHandlers(browser.storage.local, {
    onSettingsChanged: async (input) => {
      if (input.effects.includes(SETTINGS_EFFECTS.REFRESH_SCHEDULE)) {
        await refreshService.reconcileSettingsChange(input);
        await ensureAlarms(browser);
      }
    },
  }),
  ...createStorageCommandHandlers(databaseOptions, {
    browserApi: browser,
    changePublisher,
    onResetCommitted: () => actionBadgeController.sync(),
    storageArea: browser.storage.local,
  }),
});

browser.runtime.onMessage.addListener(createMessageDispatcher(router));
browser.action.onClicked.addListener(handleActionClicked);
browser.runtime.onInstalled.addListener(handleInstalled);
browser.runtime.onStartup.addListener(handleStartup);
browser.alarms.onAlarm.addListener(handleAlarm);
browser.permissions.onAdded.addListener(handlePermissionsAdded);
browser.permissions.onRemoved.addListener(handlePermissionsRemoved);

void actionBadgeController.sync();
void ensureAlarms(browser);
void reconcileStartupPermissions().catch((error) => {
  reportBackgroundError(error, 'permissions.reconcile');
});

/**
 * @param {{windowId?: unknown}} [tab]
 */
function handleActionClicked(tab = {}) {
  void readerActionController.openOrFocusReader(actionWindowPreference(tab)).catch((error) => {
    reportBackgroundError(error, 'reader.openOrFocus');
  });
}

/**
 * @param {{windowId?: unknown}} tab
 */
function actionWindowPreference(tab) {
  return typeof tab.windowId === 'number' && Number.isSafeInteger(tab.windowId) && tab.windowId >= 0
    ? { windowId: tab.windowId }
    : {};
}

function handleInstalled() {
  void actionBadgeController.sync();
  void alarmController.handleInstalled().catch((error) => {
    reportBackgroundError(error, 'alarms.installed');
  });
}

function handleStartup() {
  void actionBadgeController.sync();
  void alarmController.handleStartup().catch((error) => {
    reportBackgroundError(error, 'alarms.startup');
  });
}

/**
 * @param {{name: string}} alarm
 */
function handleAlarm(alarm) {
  void alarmController.handleAlarm(alarm).catch((error) => {
    reportBackgroundError(error, 'alarms.run');
  });
}

/**
 * @param {unknown} permissions
 */
function handlePermissionsAdded(permissions) {
  void runPermissionMutation(() => permissionController.handlePermissionsAdded(permissions)).catch((error) => {
    reportBackgroundError(error, 'permissions.added');
  });
}

/**
 * @param {unknown} permissions
 */
function handlePermissionsRemoved(permissions) {
  void runPermissionMutation(() => permissionController.handlePermissionsRemoved(permissions)).catch((error) => {
    reportBackgroundError(error, 'permissions.removed');
  });
}

async function reconcileStartupPermissions() {
  await runPermissionMutation(() => permissionController.reconcileFeedPermissions());
}

/**
 * @param {() => Promise<{mutations?: import('./change-events.js').RepositoryMutationResult[]}>} operation
 */
async function runPermissionMutation(operation) {
  const result = await operation();
  for (const mutation of result.mutations ?? []) {
    await changePublisher(mutation);
  }
}

/**
 * @param {unknown} error
 * @param {string} operation
 */
function reportBackgroundError(error, operation) {
  const code = error instanceof Error && error.name ? error.name : 'BACKGROUND_ERROR';
  console.error({ level: 'error', code, operation, atMs: Date.now() });
}
