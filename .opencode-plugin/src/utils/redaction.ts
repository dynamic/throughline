/**
 * throughline — redaction logic for OpenCode plugin.
 *
 * Ported from the jq redaction defs in _lib.sh. Two modes:
 *   - redact(): command-path redaction (aggressive, for tool outputs)
 *   - redactPrompt(): prose-safe redaction (conservative, for user prompts)
 *
 * The command path uses aggressive keyword matching that can corrupt natural
 * language (e.g., "bearer of good news" → "Bearer ***"). The prompt path
 * uses only structural patterns that never false-positive on English.
 */

// --- Constants ---

/** Sentinel for URL userinfo redaction (prevents generic rules from over-masking) */
const REDACT_SENTINEL = "TLREDACTSENTINEL";

// --- Structural patterns (safe for both command and prompt paths) ---

/**
 * Match PEM private keys.
 */
const PEM_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PEM_INCOMPLETE_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * Match URL userinfo (user:pass@host).
 * Sets sentinel to prevent generic rules from consuming past the @.
 */
function redactUrlUserinfo(str: string): string {
  return str.replace(/(\/\/[^:@/\s]+):([^@/\s]+)@/g, `$1:${REDACT_SENTINEL}@`);
}

/**
 * Match well-known token prefixes.
 */
const TOKEN_PREFIX_PATTERNS = [
  /ghp_[A-Za-z0-9]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /gh[oprsu]_[A-Za-z0-9]{10,}/g,
  /xox[baprs]-[A-Za-z0-9-]{6,}/g,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
];

/**
 * Apply all token prefix redactions.
 */
function redactTokenPrefixes(str: string): string {
  let result = str;
  result = result.replace(TOKEN_PREFIX_PATTERNS[0], "ghp_***");
  result = result.replace(TOKEN_PREFIX_PATTERNS[1], "github_pat_***");
  result = result.replace(TOKEN_PREFIX_PATTERNS[2], "gh_***");
  result = result.replace(TOKEN_PREFIX_PATTERNS[3], "xox-***");
  result = result.replace(TOKEN_PREFIX_PATTERNS[4], "sk-***");
  result = result.replace(TOKEN_PREFIX_PATTERNS[5], "AKIA***");
  result = result.replace(TOKEN_PREFIX_PATTERNS[6], "AIza***");
  return result;
}

/**
 * Unmask sentinel to final redaction marker.
 */
function unmaskSentinel(str: string): string {
  return str.replace(new RegExp(REDACT_SENTINEL, "g"), "***");
}

// --- Auth scheme patterns ---

/**
 * Bearer scheme redaction (command path, min length 1).
 */
function redactBearerScheme(str: string, minLen: number): string {
  const regex = new RegExp(`bearer\\s+([A-Za-z0-9._-]{${minLen},})`, "gi");
  return str.replace(regex, "Bearer ***");
}

/**
 * Basic scheme redaction (command path, min length 8).
 */
function redactBasicScheme(str: string, minLen: number): string {
  const regex = new RegExp(`\\bbasic\\s+[A-Za-z0-9+/=]{${minLen},}`, "gi");
  return str.replace(regex, "Basic ***");
}

/**
 * Token scheme redaction (command path).
 */
function redactTokenScheme(str: string): string {
  return str.replace(/\btoken\s+([A-Za-z0-9._-]+)/gi, "Token ***");
}

/**
 * Auth scheme redaction for command path (aggressive).
 */
function redactAuthSchemes(str: string): string {
  let result = str;
  result = redactBearerScheme(result, 1);
  result = redactBasicScheme(result, 8);
  return result;
}

/**
 * Auth scheme redaction for prompt path (prose-safe, length-gated).
 */
function redactAuthSchemesProse(str: string): string {
  let result = str;
  result = redactBearerScheme(result, 16);
  result = result.replace(/\btoken\s+([A-Za-z0-9._-]{16,})/gi, "Token ***");
  result = redactBasicScheme(result, 16);
  return result;
}

// --- Command-path redaction (aggressive) ---

/**
 * Full command-path redaction. Uses aggressive keyword matching that can
 * corrupt natural language. Safe for tool outputs and commands.
 *
 * Order matters:
 * 1. PEM keys (structural, unambiguous)
 * 2. Auth schemes (Bearer/Basic)
 * 3. Token word (DRF/GitLab-style)
 * 4. URL userinfo (sets sentinel)
 * 5. Token prefixes (ghp_, sk-, etc.)
 * 6. Generic keyword=value (catch-all)
 * 7. Unmask sentinel
 */
export function redact(str: string): string {
  let result = str;

  // 1. PEM private keys
  result = result.replace(PEM_REGEX, "***private-key-redacted***");
  result = result.replace(PEM_INCOMPLETE_REGEX, "***private-key-redacted***");

  // 2. Auth schemes
  result = redactAuthSchemes(result);

  // 3. Token word
  result = redactTokenScheme(result);

  // 4. URL userinfo
  result = redactUrlUserinfo(result);

  // 5. Token prefixes
  result = redactTokenPrefixes(result);

  // 6. Generic keyword=value (aggressive)
  // Matches: token, secret, password, passwd, api_key, access_key, credential, auth, authorization, client_id
  // With separators: :, =, " is ", " was ", " are ", or whitespace
  // Values: balanced quotes, sentinel, unterminated quotes, or bare unquoted
  const keywordRegex =
    /(\w*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|auth(?:orization)?|client[_-]?id)\w*)(\s*[:=]\s*|\s+(?:is|was|are)\s+|\s+)("[^"]*"|TLREDACTSENTINEL|"[^\r\n]*|[^\s"]+)/gi;

  result = result.replace(keywordRegex, (match, keyword, sep, value) => {
    // If value is the sentinel, keep it as-is (will be unmasked later)
    if (value === REDACT_SENTINEL) {
      return `${keyword}${sep}${value}`;
    }
    // Otherwise, replace with ***
    return `${keyword}${sep}***`;
  });

  // 7. Unmask sentinel
  result = unmaskSentinel(result);

  return result;
}

// --- Prompt-path redaction (prose-safe) ---

/**
 * Prose-safe redaction for user prompts. Uses only structural patterns
 * that never false-positive on natural language.
 *
 * Deliberately excludes generic keyword matching (which corrupts English).
 * A pasted secret with no recognizable prefix/scheme will NOT be masked
 * by this function.
 */
export function redactPrompt(str: string): string {
  let result = str;

  // 1. PEM private keys
  result = result.replace(PEM_REGEX, "***private-key-redacted***");
  result = result.replace(PEM_INCOMPLETE_REGEX, "***private-key-redacted***");

  // 2. Auth schemes (prose-safe, length-gated)
  result = redactAuthSchemesProse(result);

  // 3. URL userinfo
  result = redactUrlUserinfo(result);

  // 4. Token prefixes
  result = redactTokenPrefixes(result);

  // 5. Unmask sentinel
  result = unmaskSentinel(result);

  return result;
}

// --- Utility ---

/**
 * Clean control characters and backticks from a string.
 * Prevents breaking markdown formatting.
 */
export function clean(str: string): string {
  return str.replace(/[\x00-\x1F\x7F`]/g, " ");
}

/**
 * Clamp a string to n characters, appending ellipsis if truncated.
 */
export function clamp(str: string, maxLen: number, ellipsis = "…"): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + ellipsis;
}

/**
 * Combined pipeline: redact → clean → clamp.
 */
export function redactCleanClamp(str: string, maxLen: number, promptSafe = false): string {
  const redacted = promptSafe ? redactPrompt(str) : redact(str);
  const cleaned = clean(redacted);
  return clamp(cleaned, maxLen);
}
