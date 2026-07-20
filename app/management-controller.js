// @ts-check

import {
  createCategory,
  moveFeedToCategory,
  renameCategory,
  updateFeed,
  updateFeedWithPermission,
} from './management-api.js';
import { handleCategoryDragEvent, handleCategoryGripKeydown } from './category-reorder.js';
import { handleFeedDragEvent, handleFeedGripKeydown } from './feed-reorder.js';
import { closeMoveFeedDialog, selectedMoveFeedCategoryId } from './dialogs.js';
import { closeCategoryNameDialog } from './category-name-dialog.js';
import { createFeedOptionsMenu } from './feed-options-menu.js';
import { closeFeedEditDialog } from './feed-edit-dialog.js';
import { trapDialogTab } from './adw-dialog.js';
import {
  focusCategoryAction,
  focusFeedMenuTrigger,
  handleCategoryButton,
  handleFeedButton,
  runEventOwnedManagementAction,
  runManagementAction,
  stringData,
} from './management-actions.js';
import { validateCategoryTitleForm, validateFeedForm } from './management-form-validation.js';
import { createOpmlController } from './opml-controller.js';
import { createSettingsController } from './settings-controller.js';

/**
 * @typedef {import('./app-shell.js').AppShellOptions} AppShellOptions
 * @typedef {Awaited<ReturnType<import('./api-client.js').bootstrapApp>>} BootstrapSnapshot
 * @typedef {Awaited<ReturnType<ReturnType<import('./state-store.js').createUiStateStore>['read']>>} UiState
 *
 * @typedef {object} ManagementControllerInput
 * @property {AppShellOptions} options
 * @property {() => BootstrapSnapshot} getSnapshot
 * @property {() => UiState | null} getState
 * @property {(mutation: {settings: Record<string, unknown>, effects: string[]}) => Promise<void>} onSettingsChanged
 * @property {(patch: Partial<UiState>) => Promise<UiState>} writeState
 * @property {<T>(operation: () => Promise<T>) => Promise<T>} runWithRefreshHold
 */
/** @param {ManagementControllerInput} input */
export function createManagementController(input) {
  const opmlController = createOpmlController(input);
  const settingsController = createSettingsController(input);
  /** @type {ReturnType<typeof createFeedOptionsMenu> | null} */
  let feedOptionsMenu = null;
  const menu = () => {
    feedOptionsMenu ??= createFeedOptionsMenu(input.options.documentRef);
    return feedOptionsMenu;
  };
  return {
    prepareSnapshot: (/** @type {BootstrapSnapshot} */ snapshot) => feedOptionsMenu?.prepareForSnapshot(snapshot),
    refreshActiveSection: () => settingsController.refreshActiveSection(),
    /**
     * @param {MouseEvent} event
     */
    handleClick: (event) => handleManagementClick(input, opmlController, settingsController, menu, event),
    /**
     * @param {Event} event
     */
    handleContextMenu: (event) => handleContextMenuEvent(input, menu, event),
    /**
     * @param {Event} event
     */
    handleChange: (event) => settingsController.handleChange(event),
    /**
     * @param {KeyboardEvent} event
     */
    handleKeydown: (event) => handleManagementKeydown(input, menu, event),
    /**
     * @param {DragEvent} event
     */
    handleDrag: (event) => {
      handleCategoryDragEvent(input, event);
      handleFeedDragEvent(input, event);
    },
    /**
     * @param {SubmitEvent} event
     */
    handleSubmit: (event) => handleManagementSubmit(input, opmlController, settingsController, event),
  };
}

/**
 * @param {ManagementControllerInput} input
 * @param {() => ReturnType<typeof createFeedOptionsMenu>} menu
 * @param {Event} event
 */
function handleContextMenuEvent(input, menu, event) {
  const target = isHtmlElement(event.target) ? event.target : null;
  return openFeedOptionsForSidebarRow(input, menu, target, event);
}

/**
 * @param {ManagementControllerInput} input
 * @param {() => ReturnType<typeof createFeedOptionsMenu>} menu
 * @param {KeyboardEvent} event
 */
function handleManagementKeydown(input, menu, event) {
  const actionDialog = isHtmlElement(event.target) ? event.target.closest('dialog.action-dialog[open]') : null;
  if (isHtmlElement(actionDialog) && event.key === 'Tab') {
    trapDialogTab(actionDialog, event);
    return event.defaultPrevented;
  }
  if (event.key === 'Escape' && closeOpenActionDialog(input)) return true;
  if (isFeedContextMenuKey(event)) {
    const target = isHtmlElement(event.target) ? event.target : null;
    if (openFeedOptionsForSidebarRow(input, menu, target, event)) return true;
  }
  return handleFeedGripKeydown(input, event) || handleCategoryGripKeydown(input, event);
}

/** @param {ManagementControllerInput} input */
function closeOpenActionDialog(input) {
  const documentRef = input.options.documentRef;
  const moveForm = documentRef.querySelector('[data-move-feed-dialog][open] [data-move-feed-form]');
  if (moveForm) {
    closeMoveFeedDialog(documentRef);
    focusFeedMenuTrigger(documentRef, moveForm.getAttribute('data-move-feed-form') ?? '');
    return true;
  }
  const editForm = documentRef.querySelector('[data-feed-edit-dialog][open] [data-feed-edit-form]');
  if (editForm) {
    closeFeedEditDialog(documentRef);
    focusFeedMenuTrigger(documentRef, editForm.getAttribute('data-feed-edit-form') ?? '');
    return true;
  }
  const categoryForm = documentRef.querySelector('[data-category-name-dialog][open] form');
  if (!categoryForm) return false;
  const action = categoryForm.hasAttribute('data-category-create-form') ? 'create' : 'rename';
  const id = categoryForm.getAttribute('data-category-rename-form') ?? '';
  closeCategoryNameDialog(documentRef);
  focusCategoryAction(documentRef, action, id);
  return true;
}

/**
 * @param {KeyboardEvent} event
 */
function isFeedContextMenuKey(event) {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

/**
 * @param {ManagementControllerInput} input
 * @param {() => ReturnType<typeof createFeedOptionsMenu>} menu
 * @param {HTMLElement | null} target
 * @param {Event} event
 */
function openFeedOptionsForSidebarRow(input, menu, target, event) {
  const row = target?.closest('[data-reader-sidebar] [data-scope-key^="feed:"]');
  if (!isHtmlElement(row) || !row.dataset.feedId) return false;
  event.preventDefault();
  menu().openForTrigger(row, input.getSnapshot());
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {ReturnType<typeof createOpmlController>} opmlController
 * @param {ReturnType<typeof createSettingsController>} settingsController
 * @param {() => ReturnType<typeof createFeedOptionsMenu>} menu
 * @param {MouseEvent} event
 */
async function handleManagementClick(input, opmlController, settingsController, menu, event) {
  const grantButton = isHtmlElement(event.target)
    ? event.target.closest('[data-feed-action="grant-permission"], [data-feed-action="grant-redirect"]')
    : null;
  if (isHtmlElement(grantButton)) {
    // ARCH-003: reach permissions.request() synchronously from the user gesture,
    // before the OPML/settings handlers below introduce an unrelated await.
    const fromMenu = Boolean(grantButton.closest('[data-feed-options-menu]'));
    if (fromMenu) menu().close({ restoreFocus: false });
    await handleFeedButton(input, grantButton);
    return true;
  }
  if (await opmlController.handleClick(event)) return true;
  if (await settingsController.handleClick(event)) return true;
  const target = isHtmlElement(event.target) ? event.target : null;
  if (!target) return false;
  const section = target.closest('[data-settings-section-link]');
  if (isHtmlElement(section)) {
    const key = section.getAttribute('data-settings-section-link');
    if (isSettingsSection(key)) {
      await input.writeState({ activeSettingsSection: key });
      await settingsController.refreshActiveSection();
    }
    return true;
  }
  const menuTrigger = target.closest('[data-feed-menu-trigger]');
  if (isHtmlElement(menuTrigger)) {
    menu().openForTrigger(menuTrigger, input.getSnapshot());
    return true;
  }
  const feedButton = target.closest('[data-feed-action]');
  if (isHtmlElement(feedButton)) {
    const fromMenu = Boolean(feedButton.closest('[data-feed-options-menu]'));
    const action = stringData(feedButton, 'feedAction');
    if (fromMenu) menu().close({ restoreFocus: false });
    await handleFeedButton(input, feedButton);
    if (fromMenu && action !== 'edit')
      focusFeedMenuTrigger(input.options.documentRef, stringData(feedButton, 'feedId'));
    return true;
  }
  const categoryButton = target.closest('[data-category-action]');
  if (isHtmlElement(categoryButton)) return handleCategoryButton(input, categoryButton);
  if (target.closest('[data-move-feed-close]')) {
    const form = input.options.documentRef.querySelector('[data-move-feed-form]');
    const feedId = form?.getAttribute('data-move-feed-form') ?? '';
    closeMoveFeedDialog(input.options.documentRef);
    focusFeedMenuTrigger(input.options.documentRef, feedId);
    return true;
  }
  if (target.closest('[data-feed-edit-close]')) {
    const form = input.options.documentRef.querySelector('[data-feed-edit-dialog] form');
    const feedId = form?.getAttribute('data-feed-edit-form') ?? '';
    closeFeedEditDialog(input.options.documentRef);
    focusFeedMenuTrigger(input.options.documentRef, feedId);
    return true;
  }
  if (target.closest('[data-category-name-close]')) {
    const form = input.options.documentRef.querySelector('[data-category-name-dialog] form');
    const id = form?.getAttribute('data-category-rename-form') ?? '';
    const action = form?.hasAttribute('data-category-create-form') ? 'create' : 'rename';
    closeCategoryNameDialog(input.options.documentRef);
    focusCategoryAction(input.options.documentRef, action, id);
    return true;
  }
  return false;
}

/**
 * @param {ManagementControllerInput} input
 * @param {ReturnType<typeof createOpmlController>} opmlController
 * @param {ReturnType<typeof createSettingsController>} settingsController
 * @param {SubmitEvent} event
 */
async function handleManagementSubmit(input, opmlController, settingsController, event) {
  if (await opmlController.handleSubmit(event)) return true;
  if (await settingsController.handleSubmit(event)) return true;
  const form = isHtmlElement(event.target) ? event.target : null;
  if (!form) return false;
  if (form.hasAttribute('data-feed-edit-form')) {
    event.preventDefault();
    if (!validateFeedForm(input, form)) return true;
    await submitFeedForm(input, form);
    if (form.closest('[data-feed-edit-dialog]')) {
      closeFeedEditDialog(input.options.documentRef);
      focusFeedMenuTrigger(input.options.documentRef, form.getAttribute('data-feed-edit-form') ?? '');
    }
    return true;
  }
  if (form.hasAttribute('data-category-create-form')) {
    event.preventDefault();
    if (!validateCategoryTitleForm(input, form)) return true;
    const inDialog = Boolean(form.closest('[data-category-name-dialog]'));
    await runManagementAction(input, () =>
      createCategory({ title: formString(form, 'title') }, input.options.browserApi),
    );
    if (inDialog) {
      closeCategoryNameDialog(input.options.documentRef);
      focusCategoryAction(input.options.documentRef, 'create');
    } else clearForm(form);
    return true;
  }
  if (form.hasAttribute('data-category-rename-form')) {
    event.preventDefault();
    if (!validateCategoryTitleForm(input, form)) return true;
    const id = form.getAttribute('data-category-rename-form') ?? '';
    const inDialog = Boolean(form.closest('[data-category-name-dialog]'));
    await runManagementAction(input, () =>
      renameCategory({ id, title: formString(form, 'title') }, input.options.browserApi),
    );
    if (inDialog) {
      closeCategoryNameDialog(input.options.documentRef);
      focusCategoryAction(input.options.documentRef, 'rename', id);
    }
    return true;
  }
  if (form.hasAttribute('data-move-feed-form')) {
    event.preventDefault();
    await submitMoveFeedForm(input, form);
    return true;
  }
  return false;
}

/**
 * @param {Parameters<typeof createManagementController>[0]} input
 * @param {HTMLElement} form
 */
async function submitFeedForm(input, form) {
  const id = form.getAttribute('data-feed-edit-form') ?? '';
  const feed = input.getSnapshot().feeds.find((item) => item.id === id);
  const patch = {
    categoryId: formString(form, 'categoryId'),
    customTitle: formString(form, 'title'),
    iconColor: formRadio(form, 'iconColor'),
    iconSource: formString(form, 'iconSource') || 'auto',
    keepReadOnPurge: formCheckbox(form, 'keepReadOnPurge') ? 1 : 0,
    mainStreamState: formCheckbox(form, 'mainStreamState') ? 1 : 0,
    url: formString(form, 'url'),
  };
  const operation =
    feed && feed.url === patch.url
      ? () => updateFeed({ id, patch }, input.options.browserApi)
      : () => updateFeedWithPermission({ id, patch }, input.options.browserApi);
  const runAction = feed && feed.url === patch.url ? runManagementAction : runEventOwnedManagementAction;
  await runAction(input, operation, input.options.browserApi.i18n.getMessage('managementSaved'));
}

/**
 * @param {Parameters<typeof createManagementController>[0]} input
 * @param {HTMLElement} form
 */
async function submitMoveFeedForm(input, form) {
  const id = form.getAttribute('data-move-feed-form') ?? '';
  const categoryId = selectedMoveFeedCategoryId(input.options.documentRef);
  await runManagementAction(input, () => moveFeedToCategory({ id, categoryId }, input.options.browserApi));
  closeMoveFeedDialog(input.options.documentRef);
  focusFeedMenuTrigger(input.options.documentRef, id);
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 */
function formString(form, name) {
  const field = formControl(form, name);
  if (isInputLike(field)) return field.value.trim();
  return '';
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 */
function formRadio(form, name) {
  const field = form.querySelector(`[name="${name}"]:checked`);
  return isInputLike(field) ? field.value : '';
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 */
function formCheckbox(form, name) {
  const field = formControl(form, name);
  const view = form.ownerDocument.defaultView;
  return Boolean(view && field instanceof view.HTMLInputElement && field.checked);
}

/**
 * @param {HTMLElement} form
 * @param {string} name
 */
function formControl(form, name) {
  return form.querySelector(`[name="${name}"]`);
}

/**
 * @param {HTMLElement} form
 */
function clearForm(form) {
  if ('reset' in form && typeof form.reset === 'function') form.reset();
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLInputElement | HTMLSelectElement}
 */
function isInputLike(value) {
  return isHtmlElement(value) && 'value' in value;
}

/**
 * @param {unknown} key
 * @returns {key is UiState['activeSettingsSection']}
 */
function isSettingsSection(key) {
  return (
    key === 'general' ||
    key === 'appearance' ||
    key === 'reading' ||
    key === 'feeds' ||
    key === 'categories' ||
    key === 'storage' ||
    key === 'import'
  );
}
