// @ts-check

import { toSafeError } from '../domain/errors.js';
import { openAlertDialog } from './adw-dialog.js';
import {
  deleteCategory,
  deleteFeed,
  grantFeedPermission,
  grantFeedRedirectPermission,
  refreshOneFeed,
  updateFeed,
} from './management-api.js';
import { openCategoryNameDialog } from './category-name-dialog.js';
import { openMoveFeedDialog } from './dialogs.js';
import { openFeedEditDialog } from './feed-edit-dialog.js';
import { confirmAndMarkScopeRead } from './reader-search-actions.js';
import { announceStatus } from './toasts.js';

/** @typedef {import('./management-controller.js').ManagementControllerInput} ManagementControllerInput */

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} button
 */
export async function handleFeedButton(input, button) {
  const id = stringData(button, 'feedId');
  const action = stringData(button, 'feedAction');
  if (action === 'edit') {
    openFeedEditDialog({ documentRef: input.options.documentRef, feedId: id, snapshot: input.getSnapshot() });
  }
  if (action === 'refresh') await runFeedRefreshAction(input, id);
  if (action === 'grant-redirect') {
    await runEventOwnedManagementAction(
      input,
      () =>
        grantFeedRedirectPermission(
          { id, redirectOriginPending: stringValue(feedById(input.getSnapshot(), id)?.redirectOriginPending) },
          input.options.browserApi,
        ),
      input.options.browserApi.i18n.getMessage('feedPermissionGranted'),
    );
  }
  if (action === 'grant-permission') {
    await runEventOwnedManagementAction(
      input,
      () =>
        grantFeedPermission(
          { id, permissionOrigin: stringValue(feedById(input.getSnapshot(), id)?.permissionOrigin) },
          input.options.browserApi,
        ),
      input.options.browserApi.i18n.getMessage('feedPermissionGranted'),
    );
  }
  if (action === 'mark-read') {
    await runFeedMarkReadAction(input, id);
  }
  if (action === 'toggle-main-stream') {
    const nextState = feedById(input.getSnapshot(), id)?.mainStreamState === 1 ? 0 : 1;
    await runManagementAction(input, () =>
      updateFeed({ id, patch: { mainStreamState: nextState } }, input.options.browserApi),
    );
  }
  if (action === 'move-category') {
    openMoveFeedDialog({
      browserApi: input.options.browserApi,
      documentRef: input.options.documentRef,
      feedId: id,
      snapshot: input.getSnapshot(),
    });
  }
  if (
    action === 'delete' &&
    (await confirmAction(input, 'confirmDeleteFeed', [labelForFeed(input.getSnapshot(), id)]))
  ) {
    await runManagementAction(input, () => deleteFeed(id, input.options.browserApi));
  }
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} button
 */
export async function handleCategoryButton(input, button) {
  const id = stringData(button, 'categoryId');
  const action = stringData(button, 'categoryAction');
  if (action === 'create') {
    openCategoryNameDialog({ documentRef: input.options.documentRef, mode: 'create' });
  }
  if (action === 'rename') {
    openCategoryNameDialog({
      currentTitle: labelForCategory(input.getSnapshot(), id),
      documentRef: input.options.documentRef,
      id,
      mode: 'rename',
    });
  }
  if (
    action === 'delete' &&
    (await confirmAction(input, 'confirmDeleteCategory', [labelForCategory(input.getSnapshot(), id)]))
  ) {
    await runManagementAction(input, () => deleteCategory(id, input.options.browserApi));
  }
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {() => Promise<unknown>} operation
 * @param {string} [successMessage]
 */
export async function runManagementAction(input, operation, successMessage) {
  try {
    await input.runWithRefreshHold(operation);
    announceStatus(
      input.options.documentRef,
      successMessage ?? input.options.browserApi.i18n.getMessage('managementSaved'),
    );
  } catch (error) {
    announceActionError(input, error);
  }
}

/**
 * Run a command whose committed data-change event owns the resulting snapshot update.
 * @param {ManagementControllerInput} input
 * @param {() => Promise<unknown>} operation
 * @param {string} [successMessage]
 */
export async function runEventOwnedManagementAction(input, operation, successMessage) {
  try {
    const result = await operation();
    const failureMessageKey = refreshFailureMessageKey(result);
    if (failureMessageKey) {
      announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage(failureMessageKey));
    } else if (successMessage) {
      announceStatus(input.options.documentRef, successMessage);
    }
  } catch (error) {
    announceActionError(input, error);
  }
}

/** @param {ManagementControllerInput} input @param {string} feedId */
async function runFeedMarkReadAction(input, feedId) {
  try {
    const marked = await input.runWithRefreshHold(() => confirmAndMarkScopeRead(input, { id: feedId, type: 'feed' }));
    if (marked === null) return;
    announceStatus(
      input.options.documentRef,
      input.options.browserApi.i18n.getMessage('markScopeReadComplete', [marked]),
    );
  } catch (error) {
    announceActionError(input, error);
  }
}

/** @param {ManagementControllerInput} input @param {string} feedId */
async function runFeedRefreshAction(input, feedId) {
  await runEventOwnedManagementAction(input, () => refreshOneFeed(feedId, input.options.browserApi));
}

/** @param {ManagementControllerInput} input @param {unknown} error */
function announceActionError(input, error) {
  const safe = toSafeError(error);
  announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage(safe.messageKey));
}

/** @param {unknown} result */
function refreshFailureMessageKey(result) {
  const refresh = isRecord(result) && isRecord(result.refresh) ? result.refresh : result;
  if (!isRecord(refresh) || refresh.status !== 'failed' || !isRecord(refresh.error)) return '';
  return typeof refresh.error.messageKey === 'string' ? refresh.error.messageKey : '';
}

/**
 * @param {ManagementControllerInput} input
 * @param {string} key
 * @param {string | number | Array<string | number>} substitutions
 * @returns {Promise<boolean>}
 */
export async function confirmAction(input, key, substitutions) {
  const affirmativeKey = key === 'confirmDeleteFeed' ? 'feedDelete' : 'categoryDelete';
  const result = await openAlertDialog(input.options.documentRef, {
    affirmativeLabel: input.options.browserApi.i18n.getMessage(affirmativeKey),
    cancelLabel: input.options.browserApi.i18n.getMessage('dialogCancel'),
    destructive: true,
    heading: input.options.browserApi.i18n.getMessage(key, substitutions),
  });
  return result.confirmed;
}

/**
 * @param {Document} documentRef
 * @param {string} feedId
 */
export function focusFeedMenuTrigger(documentRef, feedId) {
  const trigger =
    documentRef.querySelector(`[data-feed-menu-trigger][data-feed-id="${feedId}"]`) ??
    documentRef.querySelector(`[data-reader-sidebar] [data-scope-key="feed:${feedId}"]`);
  const fallback =
    documentRef.querySelector('[data-settings-management-title]') ??
    documentRef.querySelector('[data-reader-sidebar] [data-scope-key][aria-current="page"]') ??
    documentRef.querySelector('[data-reader-main]');
  const target = trigger ?? fallback;
  if (documentRef.defaultView && target instanceof documentRef.defaultView.HTMLElement) target.focus();
}

/**
 * @param {Document} documentRef
 * @param {'create' | 'rename'} action
 * @param {string} [categoryId]
 */
export function focusCategoryAction(documentRef, action, categoryId = '') {
  const selector =
    action === 'create'
      ? '[data-category-action="create"]'
      : `[data-category-action="rename"][data-category-id="${categoryId}"]`;
  const target = documentRef.querySelector(selector) ?? documentRef.querySelector('[data-settings-management-title]');
  if (documentRef.defaultView && target instanceof documentRef.defaultView.HTMLElement) target.focus();
}

/**
 * @param {HTMLElement} element
 * @param {string} key
 */
export function stringData(element, key) {
  const value = element.dataset[key];
  return typeof value === 'string' ? value : '';
}

/**
 * @param {import('./management-controller.js').BootstrapSnapshot} snapshot
 * @param {string} id
 */
export function labelForFeed(snapshot, id) {
  return feedById(snapshot, id)?.title ?? id;
}

/**
 * @param {import('./management-controller.js').BootstrapSnapshot} snapshot
 * @param {string} id
 */
export function feedById(snapshot, id) {
  return snapshot.feeds.find((feed) => feed.id === id) ?? null;
}

/**
 * @param {import('./management-controller.js').BootstrapSnapshot} snapshot
 * @param {string} id
 */
export function labelForCategory(snapshot, id) {
  return snapshot.categories.find((category) => category.id === id)?.title ?? id;
}

/**
 * @param {unknown} value
 */
export function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}
