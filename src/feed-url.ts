import { isIP } from "node:net";
import { containsJwt, isSecureHttpUrl, isSensitiveName } from "./redaction";

function sensitiveUrl(url: URL): boolean {
  if (containsJwt(url.href)) return true;
  return [...url.searchParams].some(([name]) => isSensitiveName(name));
}

export function safeUrl(value: string, base?: string): string | null {
  if (
    !value ||
    value.length > 8192 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  )
    return null;
  try {
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const address = host.replace(/^\[|\]$/g, "");
    const ipVersion = isIP(address);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !host ||
      host === "localhost" ||
      /\.(?:localhost|local|internal|lan|home)$/.test(host) ||
      (!host.includes(".") && ipVersion === 0)
    )
      return null;
    if (
      ipVersion > 0 &&
      /^(?:0\.|10\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::0?$|::1$|f[cd]|fe[89ab])/i.test(
        address,
      )
    )
      return null;
    url.hostname = host;
    url.hash = "";
    return sensitiveUrl(url) ? null : url.href;
  } catch {
    return null;
  }
}

export function safeEnvelopeUrl(value: string): string | null {
  if (!isSecureHttpUrl(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function safeTransportUrl(value: string, base?: string): string | null {
  const safe = safeUrl(value, base);
  return safe && isSecureHttpUrl(safe) ? safe : null;
}

export function sourceUrl(value: string): string | null {
  const safe = safeUrl(value);
  if (safe) return safe;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return safeUrl(url.href);
  } catch {
    return null;
  }
}
