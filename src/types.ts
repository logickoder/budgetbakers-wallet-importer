/**
 * @file types.ts
 * @description Shared TypeScript interfaces derived entirely from real CouchDB
 * documents. No fields are assumed — every field and value is confirmed.
 */

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** The `replication` block inside the `user.getUser` response. */
export interface ReplicationConfig {
  dbName: string; // e.g. "bb-8d30a9fd-..."
  url: string; // e.g. "https://couch-prod-eu-2.budgetbakers.com"
  login: string; // same as userId
  token: string; // stable UUID used as the Basic auth password
  ownerId: string; // same as userId
}

export interface LoginResult {
  sessionToken: string;
  userId: string;
  replication: ReplicationConfig;
}

// ─── CouchDB documents ────────────────────────────────────────────────────────

/** Confirmed account document shape from `_all_docs` with `-Account_` prefix. */
export interface AccountDoc {
  _id: string;  // "-Account_<uuid>"
  _rev: string;
  name: string;  // matches CSV `account` column exactly
  currencyId: string;  // "-Currency_<uuid>" — used to derive currency per account
  position: number;
  archived: boolean;
  [key: string]: unknown;
}

/** Confirmed category document shape from `_all_docs` with `-Category_` prefix. */
export interface CategoryDoc {
  _id: string;  // "-Category_<uuid>"
  _rev: string;
  name: string;  // user types this exactly as seen in the app
  defaultType: number;  // 0 = income, 1 = expense
  [key: string]: unknown;
}

/** Confirmed currency document shape from `_all_docs` with `-Currency_` prefix. */
export interface CurrencyDoc {
  _id: string;  // "-Currency_<uuid>"
  _rev: string;
  code: string;  // ISO 4217 e.g. "NGN", "USD"
  [key: string]: unknown;
}

/**
 * Confirmed shape of a `Record` document in CouchDB.
 * Every field is confirmed from real documents — nothing guessed.
 *
 * Key findings:
 * - `type`:              0 = income, 1 = expense (both confirmed)
 * - `amount`:            always positive integer in **minor units × 100**
 *                        (-53.75 NGN stored as 5375)
 * - `transfer`:          boolean, always present
 * - `transferId`:        shared UUID linking both legs of a transfer pair
 * - `transferAccountId`: the OTHER account's full `-Account_<uuid>`
 * - `paymentType`:       0 = cash, 3 = electronic/bank transfer
 * - `payee`:             separate field, not embedded in `note`
 * - `recordDate`:        full ISO-8601 with time e.g. "2026-01-27T02:31:00.000Z"
 * - `recordState`:       always 1
 */
export interface WalletRecord {
  _id: string;    // "Record_<uuid>"
  _rev?: string;    // omit when creating
  type: 0 | 1;     // 0=income, 1=expense (BOTH confirmed)
  accountId: string;    // "-Account_<uuid>"
  currencyId: string;    // "-Currency_<uuid>"
  categoryId: string;    // "-Category_<uuid>"
  amount: number;    // positive integer, minor units ×100
  refAmount: number;    // always same as amount
  note: string;
  payee?: string;    // separate field — not embedded in note
  recordDate: string;    // ISO-8601 e.g. "2026-01-27T02:31:00.000Z"
  recordState: 1;         // always 1
  paymentType: number;    // 0=cash, 3=electronic transfer
  transfer: boolean;
  transferId?: string;    // shared UUID linking both legs of a transfer
  transferAccountId?: string;    // OTHER account "-Account_<uuid>" — only on transfers
  categoryChanged: boolean;   // always true on real records
  latitude: number;    // always 0.0
  longitude: number;    // always 0.0
  accuracy: number;    // always 0
  warrantyInMonth: number;    // always 0
  suggestedEnvelopeId: number;    // always 0
  photos: unknown[];  // always []
  labels: string[];  // [] or ["-HashTag_<uuid>"]
  refObjects: unknown[]; // always []
  reservedModelType: "Record";
  reservedSource: "backend" | "web";
  reservedOwnerId: string;
  reservedAuthorId: string;
  reservedCreatedAt: string;    // ISO timestamp of write time
  reservedUpdatedAt?: string;
  [key: string]: unknown;
}

/** Input for `writeRecords()` — computed fields are omitted. */
export interface NewRecord {
  accountId: string;   // "-Account_<uuid>"
  currencyId: string;   // "-Currency_<uuid>"
  categoryId: string;   // "-Category_<uuid>"
  amount: number;   // positive integer, minor units ×100
  type: 0 | 1;
  note: string;
  payee?: string;
  recordDate: string;   // ISO-8601
  paymentType: number;   // 0=cash, 3=electronic transfer
  transfer: boolean;
  transferId?: string;
  transferAccountId?: string;
}

/** CouchDB `_bulk_docs` response entry. */
export interface BulkResult {
  id: string;
  rev?: string;
  ok?: boolean;
  error?: string;
  reason?: string;
}

/** Runtime lookup maps fetched from CouchDB at login time. */
export interface LookupMaps {
  /** Account name → full "-Account_<uuid>" */
  accounts: Record<string, string>;
  /**
   * Account name → full "-Currency_<uuid>" for that account.
   * Derived from the account document's own `currencyId` field so the
   * user never needs to specify currency in the CSV.
   */
  accountCurrencies: Record<string, string>;
  /**
   * Category name → full "-Category_<uuid>".
   * Keys match CouchDB `name` exactly — the user types what they see in the app.
   */
  categories: Record<string, string>;
  /** ISO 4217 code → full "-Currency_<uuid>" (kept for reference / edge cases) */
  currencies: Record<string, string>;
  /**
   * The full `-Category_<uuid>` for "Transfer, withdraw".
   * Fetched at runtime — never hardcoded. Used by csv.ts to identify transfer
   * rows by category, not by a magic string.
   * `null` only if the category is somehow absent from the user's account.
   */
  transferCategoryId: string | null;
}

/** Raw lookup documents fetched from CouchDB before map conversion. */
export interface LookupData {
  accounts: AccountDoc[];
  categories: CategoryDoc[];
  currencies: CurrencyDoc[];
}