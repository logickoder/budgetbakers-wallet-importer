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
 */

import { v4 as uuidv4 } from "uuid";
import { isAxiosError, type AxiosInstance } from "axios";
import type { BulkResult, NewRecord, WalletRecord } from "./types.js";

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

const RECORDS_BY_CREATED_MAP = String.raw`function(doc) {
  if (!doc || typeof doc._id !== "string") return;
  if (doc._id.indexOf("Record_") !== 0) return;
  if (doc._deleted === true) return;
  if (typeof doc.reservedCreatedAt !== "string") return;

  emit(doc.reservedCreatedAt, null);
}`;

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

/**
 * Writes an array of records to CouchDB in a single `_bulk_docs` call.
 *
 * Auto-fills all `reserved*`, `recordState`, and default zero/empty fields
 * so callers only need to provide business data via `NewRecord`.
 *
 * @throws {Error} When CouchDB rejects any record.
 *
 * @example
 * const results = await writeRecords(couch, userId, [
 *   {
 *     accountId:   "-Account_15230f1e-...",
 *     currencyId:  "-Currency_38481cb0-...",
 *     categoryId:  "-Category_8013274a-...",
 *     amount:      5375,          // 53.75 NGN × 100
 *     type:        RECORD_TYPE.EXPENSE,
 *     note:        "Stamp Duty",
 *     recordDate:  "2026-01-27T02:31:00.000+00:00",
 *     paymentType: PAYMENT_TYPE.TRANSFER,
 *     transfer:    false,
 *   },
 * ]);
 */
export async function writeRecords(
  couch: AxiosInstance,
  userId: string,
  records: NewRecord[]
): Promise<BulkResult[]> {
  if (!records.length) return [];

  const now = new Date().toISOString();

  const docs: WalletRecord[] = records.map((r) => ({
    ...r,
    _id: `Record_${uuidv4()}`,
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

  const failed = res.data.filter((r) => r.error);
  if (failed.length) {
    throw new Error(
      `${failed.length} record(s) rejected by CouchDB:\n` +
      failed.map((r) => `  ${r.id}: ${r.error} — ${r.reason}`).join("\n")
    );
  }

  return res.data;
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
      [RECORDS_BY_CREATED_VIEW]: {
        map: RECORDS_BY_CREATED_MAP,
      },
    },
  };

  if (existing?._rev) next._rev = existing._rev;
  return next;
}

async function ensureRecordsCreatedView(couch: AxiosInstance): Promise<void> {
  let existing: DesignDoc | null = null;

  try {
    const res = await couch.get<DesignDoc>(`/${RECORDS_VIEW_DESIGN_ID}`);
    existing = res.data;
  } catch (error) {
    if (!isAxiosError(error) || error.response?.status !== 404) {
      throw error;
    }
  }

  const existingMap = existing?.views?.[RECORDS_BY_CREATED_VIEW]?.map;
  const needsUpsert = !existing || existingMap !== RECORDS_BY_CREATED_MAP;
  if (!needsUpsert) return;

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

/**
 * Fetches the last N records sorted by `reservedCreatedAt` descending.
 */
export async function listLastRecords(
  couch: AxiosInstance,
  limit: number
): Promise<ListedRecord[]> {
  await ensureRecordsCreatedView(couch);
  const rows = await fetchRecordsViewRows(couch, limit);

  return rows
    .filter((row) => row.id.startsWith("Record_") && typeof row.doc?._rev === "string")
    .map((row) => ({
      ref: {
        _id: row.id,
        _rev: row.doc?._rev as string,
      },
      createdAt: row.doc?.reservedCreatedAt ?? "",
      recordDate: row.doc?.recordDate ?? "",
      amount: row.doc?.amount ?? 0,
      accountId: row.doc?.accountId ?? "",
    }));
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
