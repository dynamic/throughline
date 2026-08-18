/**
 * throughline — chat-message hook (maps to UserPromptSubmit).
 *
 * Captures the user's intent (redacted, truncated) to the session buffer.
 * This records the "why" - the user's prompt - which otherwise lives only
 * in the compactable conversation.
 */

import { join } from "node:path";
import {
  type ThroughlineContext,
  tlActive,
  tlSafeSid,
  tlAppendLine,
} from "../lib.js";
import { redactPrompt, clean, clamp } from "../utils/redaction.js";

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  messageID?: string;
  variant?: string;
}

interface ChatMessageOutput {
  message: {
    role: string;
    parts: Array<{ type: string; text?: string }>;
  };
  parts: Array<{ type: string; text?: string }>;
}

/**
 * Extract user prompt text from message parts.
 */
function extractPromptText(output: ChatMessageOutput): string {
  // Only capture user messages
  if (output.message.role !== "user") return "";

  // Concatenate all text parts
  const textParts = output.message.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text || "");

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

  tlAppendLine(bufDir, sid, line);
}
