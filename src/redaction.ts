export const PUBLIC_DIAGNOSTIC_MAX_BYTES = 1024;

export const SENSITIVE_QUERY_TOKENS = new Set([
  "assertion",
  "authorization",
  "cookie",
  "credential",
  "jwt",
  "nonce",
  "passphrase",
  "passwd",
  "password",
  "secret",
  "session",
  "signature",
  "ticket",
  "token",
]);
export const SENSITIVE_QUERY_NAMES = new Set([
  "access_key_id",
  "api_key",
  "apikey",
  "auth",
  "code",
  "key",
  "oauth",
  "private_key",
  "sas",
  "sig",
  "state",
  "x_api_key",
]);
export const SENSITIVE_COMPACT_NAMES = new Set([
  "accesskeyid",
  "apikey",
  "clientsecret",
  "privatekey",
  "secretkey",
  "signingkey",
  "xapikey",
]);
export const JWT_RE =
  /(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+([^A-Za-z0-9_-]|$)/g;
export const SECRET_VALUE_RE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/i;
const SECRET_VALUE_GLOBAL_RE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/gi;
function isControlCode(code: number): boolean {
  return code <= 31 || (code >= 127 && code <= 159);
}
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (isControlCode(value.charCodeAt(index))) return true;
  }
  return false;
}
function removeEmbeddedControlCharacters(value: string): string {
  return value
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code === 10 || code === 13 ? character : isControlCode(code) ? "" : character;
    })
    .join("");
}
function replaceControlCharacters(value: string): string {
  return value
    .split("")
    .map((character) => (isControlCode(character.charCodeAt(0)) ? " " : character))
    .join("");
}

export function containsJwt(value: string): boolean {
  JWT_RE.lastIndex = 0;
  return JWT_RE.test(value);
}

export function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll("-", "_");
  const compact = normalized.replaceAll("_", "");
  const tokens = normalized.split("_");
  return (
    SENSITIVE_QUERY_NAMES.has(normalized) ||
    SENSITIVE_COMPACT_NAMES.has(compact) ||
    tokens.some((token) => SENSITIVE_QUERY_TOKENS.has(token)) ||
    normalized.startsWith("auth_") ||
    normalized.startsWith("oauth_") ||
    ["cookie", "credential", "password", "passwd", "secret", "session", "signature", "token"].some(
      (x) => compact.includes(x),
    )
  );
}

function containsSecretValue(value: string): boolean {
  return containsJwt(value) || SECRET_VALUE_RE.test(value);
}
function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
function decodedVariants(value: string): string[] {
  const values = [value];
  for (let depth = 0; depth < 3; depth += 1) {
    const next = decode(values.at(-1)!);
    if (next === null || next === values.at(-1)) break;
    values.push(next);
  }
  return values;
}
function pathHasSecrets(url: URL): boolean {
  const parts = url.pathname.split("/").filter(Boolean);
  let previous = "";
  for (const encoded of parts) {
    const decoded = decode(encoded);
    if (decoded === null) return true;
    if ((previous && isSensitiveName(previous)) || containsSecretValue(decoded)) return true;
    previous = decoded;
  }
  return false;
}
function nestedValueHasSecrets(value: string, depth = 0): boolean {
  if (containsSecretValue(value)) return true;
  for (const decoded of decodedVariants(value)) {
    if (containsSecretValue(decoded)) return true;
    for (const match of decoded.matchAll(/(?:^|[?&{,])\s*["']?([a-z0-9_-]+)["']?\s*[:=]/gi)) {
      if (isSensitiveName(match[1]!)) return true;
    }
    if (depth < 3) {
      try {
        const nestedUrl = new URL(decoded);
        if (["http:", "https:"].includes(nestedUrl.protocol) && urlHasSecrets(nestedUrl, depth + 1))
          return true;
      } catch {
        // It may be an encoded query string rather than a complete URL.
      }
      if (decoded.includes("=")) {
        const query = decoded.startsWith("?") ? decoded.slice(1) : decoded;
        for (const [name, item] of new URLSearchParams(query)) {
          if (isSensitiveName(name) || nestedValueHasSecrets(item, depth + 1)) return true;
        }
      }
    }
  }
  return false;
}
function urlHasSecrets(url: URL, depth = 0): boolean {
  if (url.username || url.password || pathHasSecrets(url)) return true;
  for (const [name, value] of url.searchParams) {
    if (isSensitiveName(name) || nestedValueHasSecrets(value, depth)) return true;
  }
  const fragment = url.hash.slice(1);
  return Boolean(fragment && nestedValueHasSecrets(fragment, depth));
}

export function isSecureHttpUrl(value: string): boolean {
  if (
    !value ||
    new TextEncoder().encode(value).byteLength > 4096 ||
    hasControlCharacters(value) ||
    /\s/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !urlHasSecrets(url);
  } catch {
    return false;
  }
}

export function boundUtf8(value: string, maxBytes: number, ellipsis = true): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.floor(maxBytes);
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) return value;
  const suffix = ellipsis && limit >= 3 ? "…" : "";
  const contentLimit = limit - new TextEncoder().encode(suffix).byteLength;
  for (
    let end = Math.min(contentLimit, bytes.byteLength);
    end >= Math.max(0, contentLimit - 3);
    end -= 1
  ) {
    try {
      return `${new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end)).trimEnd()}${suffix}`;
    } catch {
      // Move to the previous UTF-8 code point boundary.
    }
  }
  return suffix;
}

function redactPath(url: URL): void {
  let previous = "";
  url.pathname = url.pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      const decoded = decode(segment);
      const secret =
        decoded === null ||
        (previous !== "" && isSensitiveName(previous)) ||
        (decoded !== null && containsSecretValue(decoded));
      if (decoded !== null) previous = decoded;
      return secret ? "[REDACTED]" : segment;
    })
    .join("/");
}

/** Redact a URL for an envelope or diagnostic. This function never returns credentials or secrets. */
export function redactUrl(value: string, maxBytes = 4096): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    redactPath(url);
    for (const [name, item] of [...url.searchParams]) {
      if (isSensitiveName(name) || nestedValueHasSecrets(item)) {
        url.searchParams.set(name, "[REDACTED]");
      }
    }
    return boundUtf8(url.href, maxBytes);
  } catch {
    return boundUtf8(redactSensitiveAssignments(redactPlain(value)), maxBytes);
  }
}

function redactPlain(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      "[REDACTED]",
    )
    .replace(/\b(?:bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(JWT_RE, "$1[REDACTED]$2")
    .replace(SECRET_VALUE_GLOBAL_RE, "[REDACTED]");
}
function redactSensitiveAssignments(value: string): string {
  let text = value;
  for (const match of [
    ...text.matchAll(/\b([a-z0-9_-]+)(["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi),
  ]) {
    if (isSensitiveName(match[1]!))
      text = text.replace(match[0], `${match[1]}${match[2]}[REDACTED]`);
  }
  return text;
}

export function redactDiagnostic(value: unknown, maxBytes = PUBLIC_DIAGNOSTIC_MAX_BYTES): string {
  const raw = String(value || "no additional diagnostic");
  const normalizedMax = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0;
  const processingLimit = Math.max(4096, normalizedMax * 8);
  let text = removeEmbeddedControlCharacters(raw.slice(0, processingLimit))
    .replace(
      /\b(provider payload|response body|body hint)(?:\s*\([^\r\n)]*\))?\s*[:=][\s\S]*/gi,
      "$1: [REDACTED]",
    )
    .replace(
      /\b(set-cookie|cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi,
      "$1: [REDACTED]",
    )
    .replace(/(?:Screenshot|Screenshot saved to):[^\r\n]*/gi, "Screenshot: [REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
      const trailing = match.match(/[),.;\]]+$/)?.[0] ?? "";
      const url = trailing ? match.slice(0, -trailing.length) : match;
      return `${redactUrl(url, 4096)}${trailing}`;
    });
  text = redactSensitiveAssignments(redactPlain(text));
  text = replaceControlCharacters(text).replace(/\s+/g, " ").trim();
  return boundUtf8(text || "no additional diagnostic", maxBytes);
}

export function sanitizeErrorInPlace(error: unknown): Error {
  const value = error instanceof Error ? error : new Error(String(error));
  const message = redactDiagnostic(value.message, PUBLIC_DIAGNOSTIC_MAX_BYTES);
  const identity = /^[A-Za-z][A-Za-z0-9.$_-]{0,127}$/.test(value.name) ? value.name : "Error";
  const stack = redactDiagnostic(`${identity}: ${message}`, PUBLIC_DIAGNOSTIC_MAX_BYTES);
  try {
    value.message = message;
  } catch {
    Object.defineProperty(value, "message", { configurable: true, value: message, writable: true });
  }
  try {
    value.stack = stack;
  } catch {
    Object.defineProperty(value, "stack", {
      configurable: true,
      value: stack,
      writable: true,
    });
  }
  return value;
}
