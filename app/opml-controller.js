// @ts-check

import { ERROR_CODES, createAppError, toSafeError } from '../domain/errors.js';
import { commitOpmlImport, exportOpml, previewOpmlImport } from './management-api.js';
import { renderFormErrors } from './form-errors.js';
import { createPermissionOriginBatches, requestHostPermissions } from './permission-request.js';
import { cloneTemplate } from './templates.js';
import { announceStatus } from './toasts.js';

/**
 * @typedef {import('./management-controller.js').ManagementControllerInput} ManagementControllerInput
 * @typedef {object} OpmlImportFlow
 * @property {unknown} importModel
 * @property {string[][]} originBatches
 * @property {number} nextBatchIndex
 */

/**
 * @param {ManagementControllerInput} input
 */
export function createOpmlController(input) {
  /** @type {OpmlImportFlow | null} */
  let importFlow = null;
  return {
    /**
     * @param {MouseEvent} event
     */
    handleClick: (event) =>
      handleClick(
        input,
        event,
        () => importFlow,
        (nextFlow) => {
          importFlow = nextFlow;
        },
      ),
    /**
     * @param {SubmitEvent} event
     */
    handleSubmit: (event) =>
      handleSubmit(input, event, (nextFlow) => {
        importFlow = nextFlow;
      }),
  };
}

/**
 * @param {ManagementControllerInput} input
 * @param {MouseEvent} event
 * @param {() => OpmlImportFlow | null} getFlow
 * @param {(flow: OpmlImportFlow | null) => void} setFlow
 */
async function handleClick(input, event, getFlow, setFlow) {
  const target = isHtmlElement(event.target) ? event.target : null;
  if (!target) return false;
  if (target.closest('[data-opml-commit]')) {
    await commitImport(input, getFlow(), setFlow);
    return true;
  }
  if (target.closest('[data-opml-export]')) {
    await exportSubscriptions(input);
    return true;
  }
  return false;
}

/**
 * @param {ManagementControllerInput} input
 * @param {SubmitEvent} event
 * @param {(flow: OpmlImportFlow | null) => void} setFlow
 */
async function handleSubmit(input, event, setFlow) {
  const form = isHtmlElement(event.target) ? event.target : null;
  if (!form || !form.hasAttribute('data-opml-preview-form')) return false;
  event.preventDefault();
  await previewImport(input, form, setFlow);
  return true;
}

/**
 * @param {ManagementControllerInput} input
 * @param {HTMLElement} form
 * @param {(flow: OpmlImportFlow | null) => void} setFlow
 */
async function previewImport(input, form, setFlow) {
  try {
    const file = selectedFile(form);
    if (!file) {
      setFlow(null);
      renderFileError(
        input,
        toSafeError(
          createAppError(ERROR_CODES.VALIDATION_ERROR, {
            details: { field: 'opmlFile' },
            messageKey: 'opmlMissingFile',
          }),
        ).messageKey,
      );
      return;
    }
    const preview = await previewOpmlImport(await file.text(), input.options.browserApi);
    setFlow(createImportFlow(preview));
    renderPreview(input, preview);
  } catch (error) {
    setFlow(null);
    renderError(input, toSafeError(error).messageKey);
  }
}

/**
 * @param {ManagementControllerInput} input
 * @param {OpmlImportFlow | null} flow
 * @param {(flow: OpmlImportFlow | null) => void} setFlow
 */
async function commitImport(input, flow, setFlow) {
  if (!flow) {
    renderError(input, 'opmlPreviewRequired');
    return;
  }
  try {
    let nextFlow = flow;
    if (nextFlow.nextBatchIndex < nextFlow.originBatches.length) {
      await requestHostPermissions(nextFlow.originBatches[nextFlow.nextBatchIndex], 'opml.commitImport');
      nextFlow = { ...nextFlow, nextBatchIndex: nextFlow.nextBatchIndex + 1 };
      setFlow(nextFlow);
      if (nextFlow.nextBatchIndex < nextFlow.originBatches.length) {
        renderError(input, '');
        return;
      }
    }
    const result = await input.runWithRefreshHold(() =>
      commitOpmlImport(nextFlow.importModel, input.options.browserApi),
    );
    setFlow(null);
    setCommitEnabled(input.options.documentRef, false);
    void result;
    announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage('opmlImportComplete'));
  } catch (error) {
    renderError(input, toSafeError(error).messageKey);
  }
}

/**
 * @param {ManagementControllerInput} input
 */
async function exportSubscriptions(input) {
  try {
    const exported = await exportOpml(input.options.browserApi);
    if (!isRecord(exported) || typeof exported.xml !== 'string' || typeof exported.filename !== 'string') {
      throw new Error('invalid OPML export payload');
    }
    downloadText(input.options.windowRef, exported.filename, exported.xml);
    announceStatus(input.options.documentRef, input.options.browserApi.i18n.getMessage('opmlExportComplete'));
  } catch (error) {
    renderError(input, toSafeError(error).messageKey);
  }
}

/**
 * @param {ManagementControllerInput} input
 * @param {unknown} preview
 */
function renderPreview(input, preview) {
  const record = isRecord(preview) ? preview : {};
  const valid = numberValue(record.validCount);
  const origins = Array.isArray(record.originPatterns) ? record.originPatterns.filter(isString) : [];
  const summary = input.options.documentRef.querySelector('[data-opml-preview-summary]');
  if (isHtmlElement(summary)) {
    summary.textContent = valid > 0 ? input.options.browserApi.i18n.getMessage('opmlPreviewReady') : '';
  }
  renderPreviewCounts(input, record);
  renderOriginList(input.options.documentRef, origins);
  renderError(input, '', numberValue(record.invalidCount) + numberValue(record.duplicateInFileCount));
  setCommitEnabled(input.options.documentRef, valid > 0);
}

/**
 * @param {ManagementControllerInput} input
 * @param {Record<string, unknown>} preview
 */
function renderPreviewCounts(input, preview) {
  const group = input.options.documentRef.querySelector('[data-opml-preview-counts]');
  if (!isHtmlElement(group)) return;
  group.hidden = false;
  const specs = [
    ['validCount', 'opmlValidCount'],
    ['duplicateInFileCount', 'opmlDuplicateInFileCount'],
    ['alreadySubscribedCount', 'opmlAlreadySubscribedCount'],
    ['invalidCount', 'opmlInvalidCount'],
    ['categoryCount', 'opmlCategoryCount'],
    ['uniqueOriginCount', 'opmlUniqueOriginCount'],
  ];
  for (const [field, labelKey] of specs) {
    const element = group.querySelector(`[data-opml-preview-count="${field}"]`);
    if (!isHtmlElement(element)) continue;
    element.textContent = `${input.options.browserApi.i18n.getMessage(labelKey)} ${formatCount(
      input,
      numberValue(preview[field]),
    )}`;
  }
}

/**
 * @param {Document} documentRef
 * @param {string[]} origins
 */
function renderOriginList(documentRef, origins) {
  const list = documentRef.querySelector('[data-opml-origin-list]');
  if (!isHtmlElement(list)) return;
  list.replaceChildren();
  for (const origin of origins) {
    const item = cloneTemplate(documentRef, 'data-opml-origin-item-template', 'li');
    item.textContent = origin;
    list.append(item);
  }
}

/**
 * @param {ManagementControllerInput} input
 * @param {string} key
 * @param {number} [count]
 */
function renderError(input, key, count = 0) {
  clearFileError(input);
  const summary = input.options.documentRef.querySelector('[data-opml-error-summary]');
  if (!isHtmlElement(summary)) return;
  summary.hidden = !key && count === 0;
  summary.textContent = key
    ? input.options.browserApi.i18n.getMessage(key)
    : input.options.browserApi.i18n.getMessage('opmlPreviewIssues');
}

/**
 * @param {ManagementControllerInput} input
 * @param {string} key
 */
function renderFileError(input, key) {
  const control = fileInput(input.options.documentRef);
  if (!control) {
    renderError(input, key);
    return;
  }
  const message = input.options.browserApi.i18n.getMessage(key);
  renderFormErrors({
    fields: [
      {
        control,
        errorElement: htmlElement(input.options.documentRef.querySelector('[data-opml-file-error]')),
        message,
      },
    ],
    summary: htmlElement(input.options.documentRef.querySelector('[data-opml-error-summary]')),
    summaryMessage: message,
  });
  setCommitEnabled(input.options.documentRef, false);
}

/**
 * @param {ManagementControllerInput} input
 */
function clearFileError(input) {
  const control = fileInput(input.options.documentRef);
  if (!control) return;
  control.setAttribute('aria-invalid', 'false');
  const error = input.options.documentRef.querySelector('[data-opml-file-error]');
  if (isHtmlElement(error)) error.textContent = '';
}

/**
 * @param {Document} documentRef
 * @param {boolean} enabled
 */
function setCommitEnabled(documentRef, enabled) {
  const button = documentRef.querySelector('[data-opml-commit]');
  if (isHtmlElement(button) && 'disabled' in button) button.disabled = !enabled;
}

/**
 * @param {HTMLElement} form
 * @returns {File | null}
 */
function selectedFile(form) {
  const input = form.querySelector('input[type="file"]');
  if (!isHtmlElement(input) || !('files' in input) || !input.files) return null;
  return /** @type {HTMLInputElement} */ (input).files?.item(0) ?? null;
}

/**
 * @param {unknown} preview
 * @returns {OpmlImportFlow}
 */
function createImportFlow(preview) {
  const record = isRecord(preview) ? preview : {};
  return {
    importModel: record.importModel ?? null,
    nextBatchIndex: 0,
    originBatches: createPermissionOriginBatches(Array.isArray(record.originPatterns) ? record.originPatterns : []),
  };
}

/**
 * @param {Window} windowRef
 * @param {string} filename
 * @param {string} text
 */
function downloadText(windowRef, filename, text) {
  const blob = new Blob([text], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = windowRef.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  windowRef.setTimeout(() => URL.revokeObjectURL(url), 0);
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
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {unknown} value
 */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isString(value) {
  return typeof value === 'string';
}

/**
 * @param {ManagementControllerInput} input
 * @param {number} value
 */
function formatCount(input, value) {
  const i18n = input.options.browserApi.i18n;
  return typeof i18n.formatNumber === 'function'
    ? i18n.formatNumber(value)
    : new Intl.NumberFormat(i18n.getUILanguage()).format(value);
}

/**
 * @param {Document} documentRef
 */
function fileInput(documentRef) {
  const input = documentRef.querySelector('#opml-file');
  const view = documentRef.defaultView;
  return view && input instanceof view.HTMLInputElement ? input : null;
}

/**
 * @param {Element | null} value
 */
function htmlElement(value) {
  return isHtmlElement(value) ? value : null;
}
