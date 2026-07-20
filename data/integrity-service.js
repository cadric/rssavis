// @ts-check

import { STORES } from './constants.js';
import {
  FIRST_PHASE,
  emptyFindings,
  emptyRepairs,
  hasRepairs,
  isPhase,
  mergeFindings,
  mergeRepairs,
  nextPhaseAfter,
  normalizeCursor,
  processPhase,
  storesForPhase,
} from './integrity-records.js';
import { META_KEYS, readMetaValue, writeMetaValue } from './meta-repository.js';
import { runMutation, runTransaction } from './transaction.js';

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_MAX_CHUNKS = 8;
const DIAGNOSE_ID = 'integrityDiagnose';
const REPAIR_ID = 'integrityRepair';
const JOB_SCHEMA_VERSION = 1;

/**
 * @typedef {import('./transaction.js').TransactionOptions & {batchSize?: number, maxChunks?: number}} IntegrityOptions
 * @typedef {import('./integrity-records.js').IntegrityPhase} IntegrityPhase
 * @typedef {import('./integrity-records.js').IntegrityChunk} IntegrityChunk
 * @typedef {{id: string, version: number, phase: IntegrityPhase, cursor: IDBValidKey | null}} IntegrityJobState
 * @typedef {IntegrityChunk & {jobCompleted: boolean, nextPhase: IntegrityPhase}} IntegrityChunkResult
 */

/**
 * @param {IntegrityOptions} options
 */
export async function diagnoseIntegrity(options = {}) {
  const result = emptyFindings();
  const run = await runIntegrityChunks({
    id: DIAGNOSE_ID,
    metaKey: META_KEYS.INTEGRITY_DIAGNOSE,
    mode: 'diagnose',
    options,
    onChunk: (chunk) => mergeFindings(result, chunk.findings),
  });
  return { findings: result, progress: run.progress, repaired: false, status: run.status };
}

/**
 * @param {IntegrityOptions} options
 */
export async function repairIntegrity(options = {}) {
  const findings = emptyFindings();
  const repairs = emptyRepairs();
  let changed = false;
  let dataRevision = 0;
  /** @type {import('./transaction.js').MutationResultBase['change']} */
  let change = null;
  const run = await runIntegrityChunks({
    id: REPAIR_ID,
    metaKey: META_KEYS.INTEGRITY_REPAIR,
    mode: 'repair',
    options,
    onChunk: (chunk) => {
      mergeFindings(findings, chunk.findings);
      mergeRepairs(repairs, chunk.repairs);
      if (chunk.changed === true) {
        changed = true;
        dataRevision = Number(chunk.dataRevision);
        change = chunk.change ?? null;
      }
    },
  });
  return {
    findings,
    repairs,
    repaired: hasRepairs(repairs),
    status: run.status,
    progress: run.progress,
    changed,
    dataRevision,
    change,
  };
}

/**
 * @param {{id: string, metaKey: string, mode: 'diagnose' | 'repair', options: IntegrityOptions, onChunk(chunk: IntegrityChunkResult & Partial<import('./transaction.js').MutationResultBase>): void}} input
 */
async function runIntegrityChunks(input) {
  const batchSize = positiveInteger(input.options.batchSize, DEFAULT_BATCH_SIZE);
  const maxChunks = positiveInteger(input.options.maxChunks, DEFAULT_MAX_CHUNKS);
  /** @type {{phase: IntegrityPhase, processed: number} | null} */
  let progress = null;
  let status = 'partial';
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const state = await readJobState(input.metaKey, input.id, input.options);
    const result =
      input.mode === 'repair'
        ? await runRepairChunk(input.metaKey, state, batchSize, input.options)
        : await runDiagnoseChunk(input.metaKey, state, batchSize, input.options);
    input.onChunk(result);
    progress = { phase: result.nextPhase, processed: result.processed };
    if (result.jobCompleted) {
      status = 'completed';
      break;
    }
  }
  return { progress, status };
}

/**
 * @param {string} metaKey
 * @param {string} id
 * @param {IntegrityOptions} options
 */
async function readJobState(metaKey, id, options) {
  return runTransaction(
    STORES.META,
    'readonly',
    async (transaction) => normalizeJobState(await readMetaValue(transaction, metaKey), id),
    options,
  );
}

/**
 * @param {unknown} stored
 * @param {string} id
 * @returns {IntegrityJobState}
 */
function normalizeJobState(stored, id) {
  if (isRecord(stored) && stored.id === id && stored.version === JOB_SCHEMA_VERSION && isPhase(stored.phase)) {
    return { id, version: JOB_SCHEMA_VERSION, phase: stored.phase, cursor: normalizeCursor(stored.cursor) };
  }
  return { id, version: JOB_SCHEMA_VERSION, phase: FIRST_PHASE, cursor: null };
}

/**
 * @param {string} metaKey
 * @param {IntegrityJobState} state
 * @param {number} batchSize
 * @param {IntegrityOptions} options
 */
async function runDiagnoseChunk(metaKey, state, batchSize, options) {
  return runTransaction(
    storesForPhase(state.phase, true),
    'readwrite',
    async (transaction) => {
      const chunk = await processPhase(transaction, state.phase, state.cursor, batchSize, false);
      const next = nextState(state, chunk);
      await writeMetaValue(transaction, metaKey, next);
      return { ...chunk, jobCompleted: next === null, nextPhase: next?.phase ?? state.phase };
    },
    options,
  );
}

/**
 * @param {string} metaKey
 * @param {IntegrityJobState} state
 * @param {number} batchSize
 * @param {IntegrityOptions} options
 */
async function runRepairChunk(metaKey, state, batchSize, options) {
  return runMutation(
    storesForPhase(state.phase, true),
    async (context) => {
      const chunk = await processPhase(context.transaction, state.phase, state.cursor, batchSize, true);
      const next = nextState(state, chunk);
      await writeMetaValue(context.transaction, metaKey, next);
      if (hasRepairs(chunk.repairs)) {
        await context.markChanged({
          entities: ['feeds', 'articles', 'stats'],
          feedIds: chunk.repairs.movedFeedIds,
          categoryIds: chunk.repairs.movedCategoryIds,
          reason: 'integrity-repair',
        });
      }
      return { ...chunk, jobCompleted: next === null, nextPhase: next?.phase ?? state.phase };
    },
    { ...options, durability: 'relaxed' },
  );
}

/**
 * @param {IntegrityJobState} state
 * @param {IntegrityChunk} chunk
 * @returns {IntegrityJobState | null}
 */
function nextState(state, chunk) {
  if (!chunk.completed) return { ...state, cursor: chunk.cursor };
  const nextPhase = nextPhaseAfter(state.phase);
  return nextPhase ? { ...state, phase: nextPhase, cursor: null } : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
