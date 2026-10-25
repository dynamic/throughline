/**
 * throughline — chat-message hook (maps to UserPromptSubmit).
 *
 * Hands the user's prompt text to hooks/session-prompt.sh, which redacts
 * and records it (issue #179).
 */

import type { Hooks } from "@opencode-ai/plugin";
import { type ThroughlineContext, tlDisabled, runHook } from "../lib.js";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];

/** The text parts of a user message, joined; "" for any other role. */
export function extractPromptText(output: ChatMessageOutput): string {
  if (output.message.role !== "user") return "";
  return output.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => (part as { text: string }).text)
    .join(" ");
}

export async function chatMessage(
  ctx: ThroughlineContext,
  input: ChatMessageInput,
  output: ChatMessageOutput,
): Promise<void> {
  if (tlDisabled() || !input.sessionID) return;
  const prompt = extractPromptText(output);
  if (!prompt.trim()) return;
  await runHook(ctx, "session-prompt.sh", { session_id: input.sessionID, prompt });
}
