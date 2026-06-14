/**
 * @file records.ts
 * @description Writes `Record` documents directly to CouchDB via `_bulk_docs`.
 *
 * ## Why direct writes instead of the import pipeline?
 * The file-upload pipeline (`importRecords` tRPC endpoint) has two hard limits:
 *   - `dateFormatterPattern: "yyyy-MM-dd"` — time is always stripped
 *   - One account per upload file
 *
 * Writing directly with `_bulk_docs` preserves full timestamp precision and
 * supports any number of accounts in a single call.
 *
 * ## Confirmed field rules (from 20 real Record documents)
 * - `amount`          always positive integer in minor units × 100
 * - `refAmount`       always same value as `amount`
 * - `type`            0 = income, 1 = expense (both confirmed)
 * - `transfer`        boolean, always present
 * - `transferId`      shared UUID linking both legs of an inter-account transfer
 * - `transferAccountId` the OTHER account's full `-Account_<uuid>`
 * - `paymentType`     0 = cash, 3 = electronic/bank transfer
 * - `payee`           separate top-level field, not embedded in `note`
 * - `categoryChanged` always true
 * - `latitude/longitude/accuracy/warrantyInMonth/suggestedEnvelopeId` always 0
 * - `photos/refObjects` always []
 * - `labels`          always [] unless HashTags are attached
 *
 * ## Tool-only fields
 * - `importBatchId`   set by this importer on every record it writes. Used to
 *                     locate records for batch rollback. The BudgetBakers app
 *                     ignores unknown CouchDB fields.
 *
 * ## Idempotency
 * Record `_id` is derived with UUIDv5(namespace=batchId, name=row identity)
 * instead of a random UUIDv4. Re-running the same CSV under the same batch id
 * produces the same `_id` for each row, so CouchDB rejects duplicates with a
 * 409 `conflict`. Different batch id = different `_id`, so an intentional
 * re-import is still possible.
 */

import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { isAxiosError, type AxiosInstance } from "axios";
import type {
  BulkResult,
  NewRecord,
  RecordIdentity,
  WalletRecord,
} from "./types.js";

export interface RecordDocRef {
  _id: string;
  _rev: string;
}

export interface ListedRecord {
  ref: RecordDocRef;
  createdAt: string;
  recordDate: string;
  amount: number;
  accountId: string;
  importBatchId: string | null;
}

export interface WriteRecordsResult {
  results: BulkResult[];
  successCount: number;
  duplicateCount: number;
}

interface DesignDocView {
  map: string;
}

interface DesignDoc {
  _id: string;
  _rev?: string;
  language: "javascript";
  views: Record<string, DesignDocView>;
}

interface ViewRow<TDoc> {
  id: string;
  key: string;
  value: unknown;
  doc?: TDoc;
}

const RECORDS_VIEW_DESIGN_ID = "_design/budgetbakers_wallet_importer";
const RECORDS_BY_CREATED_VIEW = "records_by_reserved_created_at_v1";
const RECORDS_BY_IMPORT_BATCH_VIEW = "records_by_import_batch_v1";

const RECORDS_BY_CREATED_MAP = String.raw`function(doc) {
  if (!doc || typeof doc._id !== "string") return;
  if (doc._id.indexOf("Record_") !== 0) return;
  if (doc._deleted === true) return;
  if (typeof doc.reservedCreatedAt !== "string") return;

  emit(doc.reservedCreatedAt, null);
}`;

const RECORDS_BY_IMPORT_BATCH_MAP = String.raw`function(doc) {
  if (!doc || typeof doc._id !== "string") return;
  if (doc._id.indexOf("Record_") !== 0) return;
  if (doc._deleted === true) return;
  if (typeof doc.importBatchId !== "string") return;

  emit(doc.importBatchId, null);
}`;

const REQUIRED_VIEWS: Record<string, string> = {
  [RECORDS_BY_CREATED_VIEW]: RECORDS_BY_CREATED_MAP,
  [RECORDS_BY_IMPORT_BATCH_VIEW]: RECORDS_BY_IMPORT_BATCH_MAP,
};

/** Record `type` values — both confirmed from real documents. */
export const RECORD_TYPE = {
  INCOME: 0 as const,
  EXPENSE: 1 as const,
} as const;

/**
 * `paymentType` values confirmed from real records.
 * 0 = cash transaction (Valentines, Oyingbo).
 * 3 = electronic/bank transfer (Stamp Duty, HDMI Cable, Plantain).
 */
export const PAYMENT_TYPE = {
  CASH: 0 as const,
  TRANSFER: 3 as const,
} as const;

/** Maps CSV `payment_type` column values to CouchDB `paymentType` integers. */
export const CSV_PAYMENT_TYPE_MAP: Record<string, number> = {
  TRANSFER: PAYMENT_TYPE.TRANSFER,
  CASH: PAYMENT_TYPE.CASH,
  // Add more as encountered in other CSV exports
};

/** Generates a fresh import batch id (UUIDv4). */
export function makeImportBatchId(): string {
  return uuidv4();
}

/**
 * Derives the CouchDB `_id` for a record from its identity within a batch.
 *
 * Same `batchId` + same identity ⇒ same `_id` (CouchDB rejects with 409).
 * Different `batchId` ⇒ different `_id` (intentional re-import works).
 *
 * The batch id itself is the v5 namespace, so every batch gets its own
 * deterministic id space.
 */
export function deriveRecordId(batchId: string, identity: RecordIdentity): string {
  const name = [
    identity.accountId,
    identity.recordDate,
    identity.amount,
    identity.type,
    identity.note,
    identity.payee,
    identity.transfer ? "1" : "0",
  ].join("|");
  return `Record_${uuidv5(name, batchId)}`;
}

function isDuplicateResult(result: BulkResult): boolean {
  return result.error === "conflict";
}

/**
 * Writes an array of records to CouchDB in a single `_bulk_docs` call.
 *
 * Auto-fills all `reserved*`, `recordState`, and default zero/empty fields
 * so callers only need to provide business data via `NewRecord`.
 *
 * Each record's `_id` is derived from `batchId` + row identity (see
 * `deriveRecordId`). Re-running the same input under the same batch produces
 * the same `_id`s, so CouchDB returns 409 `conflict` for already-written rows
 * — those are surfaced as "duplicate" in the result, not thrown.
 *
 * @throws {Error} When CouchDB rejects a record with a non-conflict error.
 */
export async function writeRecords(
  couch: AxiosInstance,
  userId: string,
  records: NewRecord[],
  batchId: string
): Promise<WriteRecordsResult> {
  if (!records.length) {
    return { results: [], successCount: 0, duplicateCount: 0 };
  }

  const now = new Date().toISOString();

  const docs: WalletRecord[] = records.map((r) => ({
    ...r,
    _id: deriveRecordId(batchId, {
      accountId: r.accountId,
      recordDate: r.recordDate,
      amount: r.amount,
      type: r.type,
      note: r.note,
      payee: r.payee ?? "",
      transfer: r.transfer,
    }),
    importBatchId: batchId,
    refAmount: r.amount,      // always same as amount
    recordState: 1 as const,
    categoryChanged: true,
    latitude: 0.0,
    longitude: 0.0,
    accuracy: 0,
    warrantyInMonth: 0,
    suggestedEnvelopeId: 0,
    photos: [],
    refObjects: [],
    labels: [],
    reservedModelType: "Record" as const,
    reservedSource: "web" as const,
    reservedOwnerId: userId,
    reservedAuthorId: userId,
    reservedCreatedAt: now,
    reservedUpdatedAt: now,
  }));

  const res = await couch.post<BulkResult[]>("/_bulk_docs", { docs });

  let successCount = 0;
  let duplicateCount = 0;
  const hardFailures: BulkResult[] = [];

  for (const result of res.data) {
    if (result.ok) {
      successCount += 1;
    } else if (isDuplicateResult(result)) {
      duplicateCount += 1;
    } else if (result.error) {
      hardFailures.push(result);
    }
  }

  if (hardFailures.length) {
    throw new Error(
      `${hardFailures.length} record(s) rejected by CouchDB:\n` +
      hardFailures.map((r) => `  ${r.id}: ${r.error} — ${r.reason}`).join("\n")
    );
  }

  return {
    results: res.data,
    successCount,
    duplicateCount,
  };
}

/**
 * Fetches a single Record document by its full CouchDB id.
 * Useful for inspecting real documents or debugging.
 *
 * @example
 * const doc = await getRecord(couch, "Record_0e092dd8-2bb2-4995-9d61-7ca0a1172c5a");
 * console.log(JSON.stringify(doc, null, 2));
 */
export async function getRecord(
  couch: AxiosInstance,
  docId: string
): Promise<WalletRecord> {
  const res = await couch.get<WalletRecord>(`/${encodeURIComponent(docId)}`);
  return res.data;
}

function buildRecordsViewDoc(existing: DesignDoc | null): DesignDoc {
  const next: DesignDoc = {
    _id: RECORDS_VIEW_DESIGN_ID,
    language: "javascript",
    views: {
      ...(existing?.views ?? {}),
      ...Object.fromEntries(
        Object.entries(REQUIRED_VIEWS).map(([name, map]) => [name, { map }])
      ),
    },
  };

  if (existing?._rev) next._rev = existing._rev;
  return next;
}

async function ensureRecordsViews(couch: AxiosInstance): Promise<void> {
  let existing: DesignDoc | null = null;

  try {
    const res = await couch.get<DesignDoc>(`/${RECORDS_VIEW_DESIGN_ID}`);
    existing = res.data;
  } catch (error) {
    if (!isAxiosError(error) || error.response?.status !== 404) {
      throw error;
    }
  }

  const needsUpsert = Object.entries(REQUIRED_VIEWS).some(
    ([name, map]) => existing?.views?.[name]?.map !== map
  );
  if (!needsUpsert && existing) return;

  const next = buildRecordsViewDoc(existing);
  await couch.put(`/${RECORDS_VIEW_DESIGN_ID}`, next);
}

function buildRecordsViewPath(limit: number): string {
  const params = new URLSearchParams();
  params.set("descending", "true");
  params.set("include_docs", "true");
  params.set("limit", String(limit));
  return `/${RECORDS_VIEW_DESIGN_ID}/_view/${RECORDS_BY_CREATED_VIEW}?${params.toString()}`;
}

async function fetchRecordsViewRows(couch: AxiosInstance, limit: number): Promise<Array<ViewRow<WalletRecord>>> {
  const res = await couch.get<{ rows: Array<ViewRow<WalletRecord>> }>(buildRecordsViewPath(limit));
  return res.data.rows;
}

function toListedRecord(row: ViewRow<WalletRecord>): ListedRecord {
  return {
    ref: {
      _id: row.id,
      _rev: row.doc?._rev as string,
    },
    createdAt: row.doc?.reservedCreatedAt ?? "",
    recordDate: row.doc?.recordDate ?? "",
    amount: row.doc?.amount ?? 0,
    accountId: row.doc?.accountId ?? "",
    importBatchId: typeof row.doc?.importBatchId === "string" ? row.doc.importBatchId : null,
  };
}

/**
 * Fetches the last N records sorted by `reservedCreatedAt` descending.
 */
export async function listLastRecords(
  couch: AxiosInstance,
  limit: number
): Promise<ListedRecord[]> {
  await ensureRecordsViews(couch);
  const rows = await fetchRecordsViewRows(couch, limit);

  return rows
    .filter((row) => row.id.startsWith("Record_") && typeof row.doc?._rev === "string")
    .map(toListedRecord);
}

/**
 * Fetches all records tagged with the given `importBatchId`.
 * Returns an empty array when no records match.
 */
export async function listRecordsByBatch(
  couch: AxiosInstance,
  batchId: string
): Promise<ListedRecord[]> {
  await ensureRecordsViews(couch);

  const params = new URLSearchParams();
  params.set("include_docs", "true");
  params.set("key", JSON.stringify(batchId));

  const path = `/${RECORDS_VIEW_DESIGN_ID}/_view/${RECORDS_BY_IMPORT_BATCH_VIEW}?${params.toString()}`;
  const res = await couch.get<{ rows: Array<ViewRow<WalletRecord>> }>(path);

  return res.data.rows
    .filter((row) => row.id.startsWith("Record_") && typeof row.doc?._rev === "string")
    .map(toListedRecord);
}

export async function deleteRecords(
  couch: AxiosInstance,
  docs: RecordDocRef[]
): Promise<BulkResult[]> {
  if (!docs.length) return [];

  const res = await couch.post<BulkResult[]>("/_bulk_docs", {
    docs: docs.map((doc) => ({ _id: doc._id, _rev: doc._rev, _deleted: true })),
  });

  return res.data;
}
