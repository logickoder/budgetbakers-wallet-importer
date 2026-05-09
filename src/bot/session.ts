/**
 * @file bot/session.ts
 * @description In-memory session state per Telegram chat id.
 *
 * Each chat keeps a stable Claude `--session-id` (a UUID generated on first
 * message) that we reuse via `--resume` to maintain conversation context
 * across messages. We also stash a pending CSV proposal that Claude
 * produced, awaiting an explicit "confirmar" from the user before we
 * commit it to CouchDB.
 */

import { randomUUID } from "crypto";
import type { CsvRow } from "../csv.js";

export interface PendingProposal {
  /** Parsed CsvRow[] ready to feed into convertRows from src/csv.ts */
  rows: CsvRow[];
  /** Raw human-readable summary Claude produced, for the confirmation prompt */
  summary: string;
  /** Timestamp when the proposal was set, used for staleness checks */
  createdAt: number;
}

export interface BotSession {
  chatId: number;
  /** UUID we pass to claude --session-id / --resume. Generated on first turn. */
  claudeSessionId: string;
  /** Count of Claude invocations for this session. 0 = first turn (use --session-id). */
  turnsSent: number;
  lastSeenAt: number;
  /** A proposal awaiting "confirmar"/"si"/"yes". Cleared on confirm/cancel. */
  pending: PendingProposal | null;
}

const sessions = new Map<number, BotSession>();

export function getOrCreateSession(chatId: number): BotSession {
  let s = sessions.get(chatId);
  if (!s) {
    s = {
      chatId,
      claudeSessionId: randomUUID(),
      turnsSent: 0,
      lastSeenAt: Date.now(),
      pending: null,
    };
    sessions.set(chatId, s);
  } else {
    s.lastSeenAt = Date.now();
  }
  return s;
}

export function markTurnSent(chatId: number): void {
  const s = sessions.get(chatId);
  if (s) s.turnsSent += 1;
}

export function resetSession(chatId: number): BotSession {
  sessions.delete(chatId);
  return getOrCreateSession(chatId);
}

export function setPending(chatId: number, pending: PendingProposal): void {
  const s = getOrCreateSession(chatId);
  s.pending = pending;
}

export function takePending(chatId: number): PendingProposal | null {
  const s = sessions.get(chatId);
  if (!s) return null;
  const p = s.pending;
  s.pending = null;
  return p;
}

export function getSessionStats(): { activeChats: number } {
  return { activeChats: sessions.size };
}
