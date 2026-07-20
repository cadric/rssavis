// @ts-check

import {
  accentSwatchField,
  actionButton,
  appendFormFields,
  checkboxField,
  comboField,
  DEFAULT_SETTINGS,
  formatBytes,
  isElement,
  isHtmlElement,
  isInput,
  isRecord,
  isSelect,
  note,
  numberField,
  numberValue,
  staticTextField,
  syncSpinRows,
} from './settings-form-fields.js';
import { syncComboRows } from './settings-combo.js';
import { cloneTemplate, queryRequired } from './templates.js';

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
export function renderGeneralSection(documentRef, getMessage) {
  const section = sectionShell(documentRef, getMessage('settingsGeneral'));
  const form = formShell(documentRef, 'settingsGeneralForm', getMessage('settingsGeneral'));
  appendFormFields(
    form,
    comboField(documentRef, 'settings-language', 'language', getMessage('settingsLanguage'), [
      ['auto', getMessage('settingsLanguageAuto')],
      ['en', getMessage('settingsLanguageEnglish')],
      ['da', getMessage('settingsLanguageDanish')],
    ]),
    numberField(
      documentRef,
      'settings-refresh-interval',
      'refreshIntervalMinutes',
      getMessage('settingsRefreshInterval'),
      15,
      1440,
      '',
      spinLabels(getMessage),
    ),
    numberField(
      documentRef,
      'settings-feed-timeout',
      'feedTimeoutSeconds',
      getMessage('settingsFeedTimeout'),
      5,
      120,
      '',
      spinLabels(getMessage),
    ),
    comboField(
      documentRef,
      'settings-image-loading',
      'imageLoading',
      getMessage('settingsImageLoading'),
      [
        ['on-expand', getMessage('settingsImageOnExpand')],
        ['always', getMessage('settingsImageAlways')],
        ['never', getMessage('settingsImageNever')],
      ],
      getMessage('settingsImagePrivacy'),
    ),
    checkboxField(documentRef, 'settings-lazy-images', 'lazyLoadImages', getMessage('settingsLazyImages')),
  );
  section.append(form, renderResetSettingsRow(documentRef, getMessage));
  return section;
}

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
function renderResetSettingsRow(documentRef, getMessage) {
  const row = cloneTemplate(documentRef, 'data-settings-reset-row-template', '.settings-list');
  queryRequired(row, '[data-settings-reset-title]').textContent = getMessage('settingsResetRowTitle');
  queryRequired(row, '[data-settings-reset-subtitle]').textContent = getMessage('settingsResetRowSubtitle');
  queryRequired(row, '[data-settings-reset]').textContent = getMessage('settingsReset');
  return row;
}

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
export function renderAppearanceSection(documentRef, getMessage) {
  const section = sectionShell(documentRef, getMessage('settingsAppearance'));
  const form = formShell(documentRef, 'settingsAppearanceForm', getMessage('settingsAppearance'));
  appendFormFields(
    form,
    staticTextField(documentRef, 'settings-theme-family', getMessage('themeFamilyReadonly')),
    comboField(documentRef, 'settings-color-scheme', 'colorScheme', getMessage('colorSchemeLegend'), [
      ['system', getMessage('themeSystem')],
      ['light', getMessage('themeLight')],
      ['dark', getMessage('themeDark')],
    ]),
    accentSwatchField(documentRef, 'settings-accent-color', 'accentColor', getMessage('settingsAccentColor'), [
      ['blue', getMessage('settingsAccentBlue')],
      ['teal', getMessage('settingsAccentTeal')],
      ['green', getMessage('settingsAccentGreen')],
      ['yellow', getMessage('settingsAccentYellow')],
      ['orange', getMessage('settingsAccentOrange')],
      ['red', getMessage('settingsAccentRed')],
      ['pink', getMessage('settingsAccentPink')],
      ['purple', getMessage('settingsAccentPurple')],
      ['slate', getMessage('settingsAccentSlate')],
    ]),
  );
  section.append(form);
  return section;
}

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
export function renderReadingSection(documentRef, getMessage) {
  const section = sectionShell(documentRef, getMessage('settingsReading'));
  const form = formShell(documentRef, 'settingsReadingForm', getMessage('settingsReading'));
  appendFormFields(
    form,
    numberField(
      documentRef,
      'settings-articles-page',
      'articlesPerPage',
      getMessage('settingsArticlesPerPage'),
      20,
      250,
      '',
      spinLabels(getMessage),
    ),
    comboField(documentRef, 'settings-default-view', 'defaultArticleView', getMessage('settingsDefaultArticleView'), [
      ['compact', getMessage('viewCompact')],
      ['normal', getMessage('viewNormal')],
      ['large', getMessage('viewLarge')],
    ]),
    comboField(documentRef, 'settings-open-links', 'openLinksMode', getMessage('settingsOpenLinks'), [
      ['background-tab', getMessage('settingsOpenBackground')],
      ['foreground-tab', getMessage('settingsOpenForeground')],
      ['current-tab', getMessage('settingsOpenCurrent')],
    ]),
    checkboxField(documentRef, 'settings-mark-expand', 'markReadOnExpand', getMessage('settingsMarkReadExpand')),
    checkboxField(documentRef, 'settings-mark-open', 'markReadOnOpen', getMessage('settingsMarkReadOpen')),
    checkboxField(documentRef, 'settings-mark-scroll', 'markReadOnScroll', getMessage('settingsMarkReadScroll')),
  );
  section.append(form);
  return section;
}

/**
 * @param {Document} documentRef
 * @param {(key: string) => string} getMessage
 */
export function renderStorageSection(documentRef, getMessage) {
  const section = sectionShell(documentRef, getMessage('settingsStorage'));
  const estimate = note(documentRef, getMessage('storageEstimateLoading'));
  estimate.dataset.storageEstimate = '';
  const warning = cloneTemplate(documentRef, 'data-settings-warning-template', '[data-storage-warning]');
  warning.hidden = true;
  warning.setAttribute('role', 'status');
  const form = formShell(documentRef, 'settingsStorageForm', getMessage('settingsStorage'));
  appendFormFields(
    form,
    numberField(
      documentRef,
      'settings-purge-max-articles',
      'purgeMaxArticles',
      getMessage('settingsPurgeMaxArticles'),
      1000,
      100000,
      '',
      spinLabels(getMessage),
    ),
    numberField(
      documentRef,
      'settings-purge-max-age',
      'purgeMaxAgeDays',
      getMessage('settingsPurgeMaxAge'),
      7,
      3650,
      '',
      spinLabels(getMessage),
    ),
    checkboxField(documentRef, 'settings-keep-unread', 'keepUnreadOnPurge', getMessage('settingsKeepUnread')),
    checkboxField(documentRef, 'settings-keep-starred', 'keepStarredOnPurge', getMessage('settingsKeepStarred')),
  );
  const actions = cloneTemplate(documentRef, 'data-management-actions-template', '.management-actions');
  actions.dataset.storageActions = '';
  const resetData = actionButton(documentRef, getMessage('storageResetData'), 'storageResetData');
  resetData.classList.add('destructive');
  actions.append(actionButton(documentRef, getMessage('storagePurgeNow'), 'storagePurge'), resetData);
  section.append(estimate, warning, form, actions);
  return section;
}

/**
 * @param {Document} documentRef
 * @param {Record<string, unknown>} settings
 */
export function applySettingsValues(documentRef, settings) {
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = settings[key] ?? fallback;
    const fields = Array.from(documentRef.querySelectorAll(`[name="${key}"]`));
    const field = fields[0];
    if (isInput(field) && field.type === 'radio') {
      for (const radio of fields) {
        if (isInput(radio) && radio.type === 'radio') radio.checked = radio.value === String(value);
      }
    } else if (isInput(field) && field.type === 'checkbox') field.checked = value === true;
    else if (isInput(field) || isSelect(field)) field.value = String(value);
  }
  syncComboRows(documentRef);
  syncSpinRows(documentRef);
}

/** @param {(key: string) => string} getMessage */
function spinLabels(getMessage) {
  return {
    decreaseLabel: getMessage('settingsSpinDecrease'),
    increaseLabel: getMessage('settingsSpinIncrease'),
  };
}

/**
 * @param {Document} documentRef
 * @param {unknown} usage
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string, formatNumber?(value: number): string}} i18n
 */
export function applyStorageUsage(documentRef, usage, i18n) {
  const record = isRecord(usage) ? usage : {};
  const estimate = isRecord(record.estimate) ? record.estimate : {};
  const counts = isRecord(record.counts) ? record.counts : {};
  /** @type {((value: number) => string) | undefined} */
  const formatNumber = typeof i18n.formatNumber === 'function' ? i18n.formatNumber.bind(i18n) : undefined;
  const estimateNode = documentRef.querySelector('[data-storage-estimate]');
  if (isElement(estimateNode)) {
    estimateNode.textContent = i18n.getMessage('storageEstimateSummary', [
      formatBytes(numberValue(estimate.usageBytes), formatNumber),
      formatBytes(numberValue(estimate.quotaBytes), formatNumber),
      numberValue(counts.articles),
      numberValue(counts.feeds),
    ]);
  }
  const warning = documentRef.querySelector('[data-storage-warning]');
  if (isHtmlElement(warning)) {
    const warningRecord = isRecord(record.warning) ? record.warning : null;
    warning.hidden = !warningRecord;
    warning.textContent = warningRecord ? i18n.getMessage('errorDbQuotaExceeded') : '';
  }
  applyStorageRecoveryActions(documentRef, record, i18n);
}

/**
 * @param {Document} documentRef
 * @param {Record<string, unknown>} usage
 * @param {{getMessage(key: string, substitutions?: string | number | Array<string | number>): string}} i18n
 */
function applyStorageRecoveryActions(documentRef, usage, i18n) {
  const actions = documentRef.querySelector('[data-storage-actions]');
  if (!isHtmlElement(actions)) return;
  for (const stale of actions.querySelectorAll('[data-storage-recovery-action]')) stale.remove();
  const reset = actions.querySelector('[data-storage-reset-data]');
  for (const spec of storageRecoveryActionSpecs(usage)) {
    const button = actionButton(documentRef, i18n.getMessage(spec.messageKey), spec.datasetKey);
    button.dataset.storageRecoveryAction = spec.datasetKey;
    actions.insertBefore(button, reset ?? null);
  }
}

/**
 * @param {Record<string, unknown>} usage
 */
function storageRecoveryActionSpecs(usage) {
  const warning = isRecord(usage.warning) ? recoveryActionSet(usage.warning.recoveryActions) : new Set();
  const diagnostic = isRecord(usage.diagnostic) ? recoveryActionSet(usage.diagnostic.recoveryActions) : new Set();
  return [
    ...(warning.has('opml-export') ? [{ datasetKey: 'opmlExport', messageKey: 'opmlExport' }] : []),
    ...(diagnostic.has('rebuild-stats')
      ? [{ datasetKey: 'storageRebuildStats', messageKey: 'storageRebuildStats' }]
      : []),
    ...(diagnostic.has('repair-integrity')
      ? [{ datasetKey: 'storageRepairIntegrity', messageKey: 'storageRepairIntegrity' }]
      : []),
  ];
}

/**
 * @param {unknown} value
 */
function recoveryActionSet(value) {
  return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
}

/**
 * @param {Document} documentRef
 * @param {string} title
 */
function sectionShell(documentRef, title) {
  const section = cloneTemplate(documentRef, 'data-settings-section-template', '.settings-section');
  section.setAttribute('aria-labelledby', 'settings-main-title');
  const heading = queryRequired(section, '[data-settings-management-title]');
  heading.id = 'settings-main-title';
  heading.dataset.settingsManagementTitle = '';
  heading.textContent = title;
  return section;
}

/**
 * @param {Document} documentRef
 * @param {string} datasetKey
 * @param {string} legendText
 */
function formShell(documentRef, datasetKey, legendText) {
  const form = /** @type {HTMLFormElement} */ (cloneTemplate(documentRef, 'data-settings-form-template', 'form'));
  queryRequired(form, '[data-template-submit]').remove();
  form.className = 'settings-form';
  form.noValidate = true;
  form.dataset[datasetKey] = '';
  form.setAttribute('aria-describedby', `${datasetKey}-errors`);
  const fieldset = queryRequired(form, 'fieldset');
  fieldset.className = 'settings-group';
  const legend = queryRequired(fieldset, 'legend');
  legend.textContent = legendText;
  const errors = queryRequired(form, '[data-settings-error-summary]');
  errors.id = `${datasetKey}-errors`;
  errors.dataset.settingsErrorSummary = '';
  errors.hidden = true;
  errors.setAttribute('role', 'alert');
  return form;
}
