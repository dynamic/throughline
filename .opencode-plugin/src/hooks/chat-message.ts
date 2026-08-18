/**
 * throughline — chat-message hook (maps to UserPromptSubmit).
 *
 * Captures the user's intent (redacted, truncated) to the session buffer.
 * This records the "why" - the user's prompt - which otherwise lives only
 * in the compactable conversation.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Hooks } from "@opencode-ai/plugin";
import {
  type ThroughlineContext,
  tlActive,
  tlSafeSid,
  tlAppendLine,
  tlErr,
} from "../lib.js";
import { redactPrompt, clean, clamp } from "../utils/redaction.js";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];

/**
 * Extract user prompt text from message parts.
 *
 * UserMessage itself carries no `parts` — the text lives in the sibling
 * `output.parts` array (see @opencode-ai/sdk UserMessage / Hooks["chat.message"]).
 */
function extractPromptText(output: ChatMessageOutput): string {
  // Only capture user messages
  if (output.message.role !== "user") return "";

  // Concatenate all text parts
  const textParts = output.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => (part as { text: string }).text);

  return textParts.join(" ");
}

/**
 * Chat message hook implementation.
 */
export async function chatMessage(
  ctx: ThroughlineContext,
  input: ChatMessageInput,
  output: ChatMessageOutput,
): Promise<void> {
  const state = tlActive(ctx);
  if (!state.active) return;

  const sid = tlSafeSid(input.sessionID);
  if (!sid) return;

  // Extract prompt text
  const rawPrompt = extractPromptText(output);
  if (!rawPrompt || rawPrompt.trim() === "") return;

  // Build the capture line
  // 1. Clamp raw text to 2000 chars BEFORE redacting (performance)
  // 2. Redact with prose-safe redaction
  // 3. Clean control chars
  // 4. Clamp to 200 chars for buffer
  const clampedRaw = clamp(rawPrompt, 2000, "");
  const redacted = redactPrompt(clampedRaw);
  const cleaned = clean(redacted);
  const finalText = clamp(cleaned, 200, "…[truncated]");

  if (!finalText || finalText.trim() === "") return;

  const bufDir = join(state.dataDir, "buffer");
  const line = `**prompt** ${finalText}`;

  // A chat message is normally the FIRST capture event of a session — the
  // buffer dir does not exist yet at this point (tlActive() only bootstraps
  // dataDir, not dataDir/buffer). Without this, appendFileSync in
  // tlAppendLine throws ENOENT, is swallowed, and the session's opening
  // prompt is silently dropped. See tool-execute-after.ts, which needs the
  // same mkdir for the same reason.
  try {
    mkdirSync(bufDir, { recursive: true });
  } catch (err) {
    tlErr(state.dataDir, `mkdir failed for buffer dir: ${err}`);
    return;
  }

  tlAppendLine(bufDir, sid, line);
}
