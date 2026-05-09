/**
 * @file bot/handlers.ts
 * @description Telegram event handlers wired in from index.ts.
 *
 * Flow per incoming user turn:
 *  1. Allowlist guard (chat id must be in TELEGRAM_ALLOWED_CHAT_IDS).
 *  2. If the user was awaiting a confirmation and replies "si"/"confirmar",
 *     we hand the pending CsvRow[] to writeRecords and bypass Claude.
 *  3. Otherwise we build a prompt (text + optional file path), call
 *     runClaude, and inspect the reply for a fenced CSV block. If found,
 *     we stash it as pending and ask the user to confirm. If not, we
 *     just relay Claude's text to Telegram.
 *
 * Claude is told (via append-system-prompt) to never call the writer
 * itself — it only proposes the CSV. The bot is the sole writer.
 */

import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";

import type { AxiosInstance } from "axios";
import type { LookupMaps } from "../types.js";
import { convertRows, parseCsv } from "../csv.js";
import type { CsvRow } from "../csv.js";
import { writeRecords } from "../records.js";
import type { Logger } from "../logger.js";

import type { BotConfig } from "./config.js";
import { runClaude } from "./claude-runner.js";
import { downloadTelegramFile } from "./telegram-files.js";
import {
  getOrCreateSession,
  markTurnSent,
  resetSession,
  setPending,
  takePending,
  type BotSession,
} from "./session.js";

interface HandlerDeps {
  bot: Telegraf;
  config: BotConfig;
  couch: AxiosInstance;
  userId: string;
  lookup: LookupMaps;
  log: Logger;
}

const SYSTEM_PROMPT = `Eres un asistente de finanzas integrado en un bot de Telegram para BudgetBakers Wallet. El usuario te enviará fotos de tickets, PDFs de estados de cuenta o texto describiendo gastos.

Tu trabajo:
1. Analizar el contenido (lee imágenes/PDFs con Read si te dan un path).
2. Extraer movimientos (monto, fecha, comercio, cuenta, categoría sugerida).
3. Si te falta información, PREGUNTA al usuario en lenguaje natural y termina ahí. NO emitas CSV.
4. Cuando tengas todo claro, propón los registros como CSV en este formato exacto:

<<<CSV>>>
date,account,amount,category,note,payee
2026-05-09 12:00:00,Bancomer,-150.50,Restaurant fast-food,,Starbucks
<<<END>>>

5. Antes y/o después del bloque CSV, agrega un resumen humano de 1-3 líneas de lo que vas a registrar.

REGLAS DURAS:
- NUNCA ejecutes Bash con node, npm, pnpm, ni invoques dist/cli/index.js. El bot escribe a CouchDB después de que el usuario confirme con "si"/"confirmar".
- NUNCA llames herramientas mcp__claude_ai_Wallet__ que escriban (esas son solo lectura, igual confirma).
- Categorías y nombres de cuenta deben coincidir exactamente con los del usuario (ver memoria del proyecto: accounts.md, categories.md, feedback*.md).
- Categorías con coma van entre comillas en el CSV (ej. "Restaurant, fast-food").
- Si no estás seguro de algún campo, pregunta. No inventes.
- Mantén las respuestas concisas, este es un chat de Telegram.

El bot mostrará tu respuesta tal cual al usuario en Telegram. Si emites el bloque <<<CSV>>>, el bot lo extraerá, lo mostrará al usuario, y le pedirá confirmar antes de escribir.`;

const CONFIRM_WORDS = new Set([
  "si", "sí", "yes", "y", "ok", "okay", "confirmar", "confirma", "dale", "go",
]);
const CANCEL_WORDS = new Set([
  "no", "n", "cancelar", "cancela", "cancel", "abort", "stop",
]);

function isAllowed(ctx: Context, allowed: Set<number>): boolean {
  const id = ctx.chat?.id;
  return typeof id === "number" && allowed.has(id);
}

const CSV_BLOCK_RE = /<<<CSV>>>\s*([\s\S]*?)\s*<<<END>>>/;

function extractCsvBlock(text: string): { csv: string | null; cleanedText: string } {
  const m = text.match(CSV_BLOCK_RE);
  if (!m) return { csv: null, cleanedText: text };
  const csv = m[1].trim();
  const cleanedText = text.replace(CSV_BLOCK_RE, "").trim();
  return { csv, cleanedText };
}

async function sendLong(ctx: Context, text: string): Promise<void> {
  if (!text) return;
  const MAX = 4000;
  for (let i = 0; i < text.length; i += MAX) {
    await ctx.reply(text.slice(i, i + MAX));
  }
}

async function processUserTurn(
  deps: HandlerDeps,
  ctx: Context,
  session: BotSession,
  prompt: string
): Promise<void> {
  const { config, log } = deps;
  const isFirstTurn = session.turnsSent === 0;

  await ctx.sendChatAction("typing").catch(() => {});

  const result = await runClaude({
    config,
    sessionId: session.claudeSessionId,
    isFirstTurn,
    prompt,
    appendSystemPrompt: SYSTEM_PROMPT,
    disallowedTools: [
      "Bash(node*)",
      "Bash(npm*)",
      "Bash(pnpm*)",
      "Bash(npx*)",
      "Bash(tsx*)",
      "Bash(./dist/*)",
      "Bash(dist/*)",
    ],
    timeoutMs: 240_000,
  });

  markTurnSent(session.chatId);

  log("Claude turn", {
    chatId: session.chatId,
    sessionId: session.claudeSessionId,
    isFirstTurn,
    ok: result.ok,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    textLen: result.text.length,
  });

  if (!result.ok) {
    await ctx.reply(
      `⚠️ Claude reportó un error: ${result.text.slice(0, 500)}\n\n` +
        `Reintenta, o usa /reset para empezar la conversación de cero.`
    );
    return;
  }

  const { csv, cleanedText } = extractCsvBlock(result.text);

  if (csv) {
    let rows: CsvRow[];
    try {
      rows = parseCsv(csv);
    } catch (err) {
      await ctx.reply(
        `⚠️ Claude propuso un CSV pero no pude parsearlo: ${
          err instanceof Error ? err.message : String(err)
        }\nTexto crudo:\n\n${csv.slice(0, 1000)}`
      );
      return;
    }

    if (rows.length === 0) {
      await ctx.reply(
        "⚠️ Claude emitió un bloque CSV vacío. Intenta describir el gasto otra vez."
      );
      return;
    }

    setPending(session.chatId, {
      rows,
      summary: cleanedText,
      createdAt: Date.now(),
    });

    const preview = cleanedText
      ? `${cleanedText}\n\n`
      : "";
    const csvPreview = csv.length > 1500 ? csv.slice(0, 1500) + "\n…(truncado)" : csv;

    await sendLong(
      ctx,
      `${preview}📋 Propuesta (${rows.length} registro${rows.length === 1 ? "" : "s"}):\n\`\`\`\n${csvPreview}\n\`\`\`\n\nResponde *si* / *confirmar* para escribir, o *no* / *cancelar* para descartar.`
    );
    return;
  }

  await sendLong(ctx, cleanedText || "(sin respuesta)");
}

async function commitPending(
  deps: HandlerDeps,
  ctx: Context,
  session: BotSession
): Promise<void> {
  const pending = takePending(session.chatId);
  if (!pending) {
    await ctx.reply("No hay nada pendiente de confirmar.");
    return;
  }

  await ctx.sendChatAction("typing").catch(() => {});

  const { records, originalRows, skipped } = convertRows(pending.rows, deps.lookup);

  if (records.length === 0) {
    await ctx.reply(
      `⚠️ No quedaron registros válidos tras la conversión. ${skipped.length} fueron descartados.\n` +
        skipped
          .slice(0, 5)
          .map((s, i) => `[${i + 1}] ${s.reason}`)
          .join("\n")
    );
    return;
  }

  let results;
  try {
    results = await writeRecords(deps.couch, deps.userId, records);
  } catch (err) {
    deps.log.error("writeRecords threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(
      `❌ Falló la escritura a CouchDB: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;

  deps.log("Bot import committed", {
    chatId: session.chatId,
    sessionId: session.claudeSessionId,
    ok,
    fail,
    skipped: skipped.length,
    proposedAt: pending.createdAt,
  });

  let msg = `✅ ${ok} registro${ok === 1 ? "" : "s"} escrito${ok === 1 ? "" : "s"}.`;
  if (fail > 0) msg += `\n❌ ${fail} fallaron en CouchDB.`;
  if (skipped.length > 0) msg += `\n⏭️ ${skipped.length} omitidos en validación.`;
  await ctx.reply(msg);
}

export function registerHandlers(deps: HandlerDeps): void {
  const { bot, config, log } = deps;

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx, config.allowedChatIds)) {
      log.warn("Unauthorized chat", { chatId: ctx.chat?.id, from: ctx.from?.username });
      await ctx.reply("⛔ No autorizado.");
      return;
    }
    return next();
  });

  bot.command("start", async (ctx) => {
    const s = getOrCreateSession(ctx.chat.id);
    await ctx.reply(
      `Hola. Mándame una foto, un PDF o describe un gasto en texto.\n` +
        `Sesión: \`${s.claudeSessionId.slice(0, 8)}…\`\n` +
        `Comandos: /reset (nueva conversación), /cancel (descartar propuesta).`
    );
  });

  bot.command("reset", async (ctx) => {
    const s = resetSession(ctx.chat.id);
    await ctx.reply(`🔄 Conversación reiniciada. Sesión: \`${s.claudeSessionId.slice(0, 8)}…\``);
  });

  bot.command("cancel", async (ctx) => {
    const taken = takePending(ctx.chat.id);
    await ctx.reply(taken ? "🗑️ Propuesta descartada." : "Nada pendiente que cancelar.");
  });

  bot.on(message("photo"), async (ctx) => {
    try {
      const session = getOrCreateSession(ctx.chat.id);

      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const downloaded = await downloadTelegramFile(bot, ctx, largest.file_id, {
        downloadDir: config.downloadDir,
        mimeType: "image/jpeg",
        fallbackExt: ".jpg",
      });

      log("Photo received", {
        chatId: ctx.chat.id,
        path: downloaded.localPath,
        size: downloaded.sizeBytes,
      });

      const caption = ctx.message.caption?.trim() ?? "";
      const prompt =
        `El usuario envió una foto en Telegram. Está guardada localmente en:\n${downloaded.localPath}\n\n` +
        (caption ? `Caption del usuario: "${caption}"\n\n` : "") +
        `Analízala (lee el archivo con Read), extrae los movimientos y propón el CSV cuando estés listo, o pregunta lo que falte.`;

      await processUserTurn(deps, ctx, session, prompt);
    } catch (err) {
      log.error("Photo handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(
        `❌ Error procesando la foto: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  bot.on(message("document"), async (ctx) => {
    try {
      const session = getOrCreateSession(ctx.chat.id);

      const doc = ctx.message.document;
      const downloaded = await downloadTelegramFile(bot, ctx, doc.file_id, {
        downloadDir: config.downloadDir,
        mimeType: doc.mime_type ?? null,
        fallbackExt: doc.file_name ? `.${doc.file_name.split(".").pop()}` : ".bin",
      });

      log("Document received", {
        chatId: ctx.chat.id,
        path: downloaded.localPath,
        mime: doc.mime_type,
        size: downloaded.sizeBytes,
      });

      const caption = ctx.message.caption?.trim() ?? "";
      const prompt =
        `El usuario envió un documento en Telegram (${doc.mime_type ?? "tipo desconocido"}, ${
          downloaded.sizeBytes
        } bytes). Guardado en:\n${downloaded.localPath}\n\n` +
        (caption ? `Caption: "${caption}"\n\n` : "") +
        `Léelo (con Read; si es PDF puedes pasar pages para PDFs grandes), extrae movimientos y propón el CSV cuando estés listo. Si necesitas info, pregunta.`;

      await processUserTurn(deps, ctx, session, prompt);
    } catch (err) {
      log.error("Document handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(
        `❌ Error procesando el documento: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();
    const session = getOrCreateSession(ctx.chat.id);

    if (session.pending) {
      const word = text.toLowerCase();
      if (CONFIRM_WORDS.has(word)) {
        await commitPending(deps, ctx, session);
        return;
      }
      if (CANCEL_WORDS.has(word)) {
        takePending(ctx.chat.id);
        await ctx.reply("🗑️ Propuesta descartada.");
        return;
      }
      // Falls through: user is amending the proposal — let Claude refine it.
    }

    try {
      await processUserTurn(deps, ctx, session, text);
    } catch (err) {
      log.error("Text handler failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply(
        `❌ Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}
