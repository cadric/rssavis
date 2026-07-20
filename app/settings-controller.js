// @ts-check

import { toSafeError } from '../domain/errors.js';
import { normalizeSettingsEffects } from '../shared/settings-effects.js';
import { openAlertDialog } from './adw-dialog.js';
import { renderFormErrors } from './form-errors.js';
import { applySettingsValues, applyStorageUsage } from './settings-sections.js';
import {
  getSettings,
  getStorageUsage,
  purgeStorage,
  rebuildStats,
  repairIntegrity,
  resetAllData,
  resetSettings,
  updateSettings,
} from './settings-api.js';
import { announceStatus } from './toasts.js';
import { createSettingsListbox } from './settings-combo.js';

/** @typedef {import('./management-controller.js').ManagementControllerInput} ManagementControllerInput */

/**
 * @param {ManagementControllerInput} input
 */
export function createSettingsController(input) {
  let settingsListbox = /** @type {ReturnType<typeof createSettingsListbox> | null} */ (null);
  const listbox = () => {
    settingsListbox ??= createSettingsListbox(input.options.documentRef);
    return settingsListbox;
  };
  return {
    refreshActiveSection: () => refreshActiveSection(input),
    /**
     * @param {MouseEvent} event
     */
    handleClick: (event) => handleClick(input, listbox, event),
    /**
     * @param {Event} event
     */
    handleChange: (event) => handleChange(input, event),
    /**
     * @param {SubmitEvent} event
     */
    handleSubmit: (event) => handleSubmit(input, event),
  };
}

/**
 * @param {ManagementControllerInput} input
 */
async function refreshActiveSection(input) {
  const section = input.getState()?.activeSettingsSection;
  if (!section || !['appearance', 'general', 'reading', 'storage'].includes(section)) return;
  try {
    applySettingsValues(input.options.documentRef, await getSettings(input.options.browserApi));
    if (section === 'storage') {
      applyStorageUsage(
        input.options.documentRef,
        await getStorageUsage(input.options.browserApi),
        input.options.browserApi.i18n,
      );
    }
  } catch (error) {
    announceError(input, error);
  }
}

/**
 * @param {ManagementControllerInput} input
 * @param {() => ReturnType<typeof createSettingsListbox>} listbox
 * @param {MouseEvent} event
 */
async function handleClick(input, listbox, event) {
  const target = isElement(event.target) ? event.target : null;
  if (!target) return false;
  const comboTrigger = target.closest('[data-settings-combo-trigger]');
  if (isHtmlElement(comboTrigger)) {
    event.preventDefault();
    return listbox().openForTrigger(comboTrigger);
  }
  if (activateSettingsRow(target, listbox, event)) return true;
  if (target.closest('[data-storage-purge]')) {
    await purgeWithConfirmation(input);
    return true;
  }
  if (target.closest('[data-storage-rebuild-stats]')) {
    await runAction(input, () => rebuildStats(input.options.browserApi), 'statsRebuildComplete');
    return true;
  }
  if (target.closest('[data-storage-repair-integrity]')) {
    await runAction(input, () => repairIntegrity(input.options.browserApi), 'integrityRepairComplete');
    return true;
  }
  if (target.closest('[data-settings-reset]')) {
    await runSettingsAction(input, () => resetSettings(input.options.browserApi));
    return true;
  }
  if (target.closest('[data-storage-reset-data]')) {
    await resetDataWithConfirmation(input);
    return true;
  }
  return false;
}

/**
 * @param {Element} target
 * @param {() => ReturnType<typeof createSettingsListbox>} listbox
 * @param {MouseEvent} event
 */
function activateSettingsRow(target, listbox, event) {
  const row = target.closest('[data-settings-main] .settings-row');
  if (!isHtmlElement(row) || !isPreferenceActivationRow(row) || isRowControlClick(target)) return false;
  const comboTrigger = row.querySelector('[data-settings-combo-trigger]');
  if (isHtmlElement(comboTrigger)) {
    event.preventDefault();
    return listbox().openForTrigger(comboTrigger);
  }
  const input = row.querySelector('input, select, textarea');
  if (isHtmlElement(input)) {
    event.preventDefault();
    input.focus();
    return true;
  }
  return false;
}

/** @param {HTMLElement} row */
function isPreferenceActivationRow(row) {
  if (row.classList.contains('settings-toggle-row')) return false;
  if (row.classList.contains('settings-accent-row')) return false;
  if (row.classList.contains('settings-reset-row')) return false;
  if (row.classList.contains('management-item-row')) return false;
  if (row.classList.contains('management-action-row')) return false;
  return (
    row.classList.contains('settings-input-row') ||
    row.classList.contains('settings-combo-row') ||
    row.classList.contains('settings-spin-row')
  );
}

/** @param {Element} target */
function isRowControlClick(target) {
  return Boolean(target.closest('.settings-row-control, button, input, select, textarea, a'));
}

/**
 * @param {ManagementControllerInput} input
 * @param {Event} event
 */
async function handleChange(input, event) {
  const field = settingsField(event.target);
  const form = field?.closest('form');
  if (!field || !isHtmlElement(form) || !isSettingsForm(form)) return false;
  if (!validateField(input, form, field)) return true;
  const patch = collectFieldPatch(field);
  if (!patch) return true;
  await runSettingsAction(input, () => updateSettings(patch, input.options.browserApi));
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {SubmitEvent} event
 */
async function handleSubmit(input, event) {
  const form = isHtmlElement(event.target) ? event.target : null;
  if (!form || !isSettingsForm(form)) return false;
  event.preventDefault();
  return true;
}

/**
 * @param {ManagementControllerInput} input
 */
async function purgeWithConfirmation(input) {
  const usage = await getStorageUsage(input.options.browserApi);
  const count = articleCount(usage);
  const confirmed = await openAlertDialog(input.options.documentRef, {
    affirmativeLabel: input.options.browserApi.i18n.getMessage('storagePurgeNow'),
    cancelLabel: input.options.browserApi.i18n.getMessage('dialogCancel'),
    destructive: true,
    heading: input.options.browserApi.i18n.getMessage('storagePurgeConfirm', count),
  });
  if (!confirmed.confirmed) return;
  await runAction(input, () => purgeStorage(input.options.browserApi), 'cleanupComplete');
}

/**
 * @param {ManagementControllerInput} input
 */
async function resetDataWithConfirmation(input) {
  const phrase = input.options.browserApi.i18n.getMessage('extensionName');
  const confirmed = await openAlertDialog(input.options.documentRef, {
    affirmativeLabel: input.options.browserApi.i18n.getMessage('storageResetData'),
    cancelLabel: input.options.browserApi.i18n.getMessage('dialogCancel'),
    destructive: true,
    heading: input.options.browserApi.i18n.getMessage('storageResetDataConfirm', phrase),
    typedConfirmValue: phrase,
  });
  if (!confirmed.confirmed) return;
  await runAction(input, () => resetAllData(input.options.browserApi), 'storageResetDataComplete');
}

/**
 * @param {ManagementControllerInput} input
 * @param {() => Promise<unknown>} operation
 */
async function runSettingsAction(input, operation) {
  const result = await runAction(input, operation, 'settingsSaved', { refreshActiveSection: false });
  if (!result) return false;
  const mutation = readSettingsMutationResult(result);
  await input.onSettingsChanged(mutation);
  applySettingsValues(input.options.documentRef, mutation.settings);
  await refreshActiveSection(input);
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {() => Promise<unknown>} operation
 * @param {string} messageKey
 * @param {{refreshActiveSection?: boolean}} [options]
 */
async function runAction(input, operation, messageKey, options = {}) {
  try {
    const result = await input.runWithRefreshHold(operation);
    if (options.refreshActiveSection !== false) await refreshActiveSection(input);
    announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage(messageKey));
    return result ?? true;
  } catch (error) {
    announceError(input, error);
    return false;
  }
}

/**
 * @param {ManagementControllerInput} input
 * @param {unknown} error
 */
function announceError(input, error) {
  const safe = toSafeError(error);
  announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage(safe.messageKey));
}

/**
 * @param {HTMLElement} form
 */
function isSettingsForm(form) {
  return (
    form.hasAttribute('data-settings-general-form') ||
    form.hasAttribute('data-settings-appearance-form') ||
    form.hasAttribute('data-settings-reading-form') ||
    form.hasAttribute('data-settings-storage-form')
  );
}

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} form
 * @param {HTMLInputElement | HTMLSelectElement} field
 */
function validateField(input, form, field) {
  if (!isInput(field) || field.type !== 'number') return true;
  const value = Number(field.value);
  const min = Number(field.min);
  const max = Number(field.max);
  const fieldValid = Number.isSafeInteger(value) && value >= min && value <= max;
  return renderFormErrors({
    fields: [
      {
        control: field,
        errorElement: field.ownerDocument.getElementById(`${field.id}-error`),
        message: fieldValid
          ? ''
          : input.options.browserApi.i18n.getMessage('settingsRangeError', [field.min, field.max]),
      },
    ],
    summary: htmlElement(form.querySelector('[data-settings-error-summary]')),
    summaryMessage: input.options.browserApi.i18n.getMessage('settingsFormErrorSummary'),
  });
}

/**
 * @param {HTMLInputElement | HTMLSelectElement} field
 * @returns {Record<string, unknown> | null}
 */
function collectFieldPatch(field) {
  if (!field.name) return null;
  if (isInput(field) && field.type === 'radio' && !field.checked) return null;
  const value = isInput(field) && field.type === 'checkbox' ? field.checked : fieldValue(field);
  return { [field.name]: value };
}

/**
 * @param {unknown} value
 * @returns {{settings: Record<string, unknown>, effects: string[]}}
 */
function readSettingsMutationResult(value) {
  const record = isRecord(value) ? value : {};
  return {
    effects: normalizeSettingsEffects(record.effects),
    settings: isRecord(record.settings) ? record.settings : {},
  };
}

/**
 * @param {HTMLInputElement | HTMLSelectElement} field
 */
function fieldValue(field) {
  return isInput(field) && field.type === 'number' ? Number(field.value) : field.value;
}

/**
 * @param {unknown} usage
 */
function articleCount(usage) {
  if (!isRecord(usage) || !isRecord(usage.counts)) return 0;
  return typeof usage.counts.articles === 'number' ? usage.counts.articles : 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {unknown} value
 * @returns {value is Element}
 */
function isElement(value) {
  return typeof value === 'object' && value !== null && 'nodeType' in value && value.nodeType === 1;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isHtmlElement(value) {
  return isElement(value) && 'hidden' in value;
}

/**
 * @param {unknown} value
 * @returns {HTMLElement | null}
 */
function htmlElement(value) {
  return isHtmlElement(value) ? /** @type {HTMLElement} */ (value) : null;
}

/**
 * @param {unknown} value
 * @returns {HTMLInputElement | HTMLSelectElement | null}
 */
function settingsField(value) {
  return isInput(value) || isSelect(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLInputElement}
 */
function isInput(value) {
  return isElement(value) && 'type' in value && 'checked' in value && 'value' in value;
}

/**
 * @param {unknown} value
 * @returns {value is HTMLSelectElement}
 */
function isSelect(value) {
  return isElement(value) && 'selectedIndex' in value && 'value' in value;
}
