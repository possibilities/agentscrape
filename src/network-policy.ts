import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type NetworkResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

export type NetworkPolicyFaultReason = "private_destination";
export type NetworkResolutionFaultReason =
  | "resolution_failed"
  | "no_addresses"
  | "malformed_addresses";

export class NetworkPolicyFault extends Error {
  constructor(public readonly reason: NetworkPolicyFaultReason) {
    super("The destination did not resolve exclusively to public network addresses.");
    this.name = "NetworkPolicyFault";
  }
}

export class NetworkResolutionFault extends Error {
  constructor(
    public readonly reason: NetworkResolutionFaultReason,
    public readonly resolutionCause?: unknown,
  ) {
    super(
      reason === "no_addresses"
        ? "The destination resolved to no network addresses."
        : reason === "malformed_addresses"
          ? "The destination returned malformed network addresses."
          : "The destination hostname could not be resolved.",
    );
    this.name = "NetworkResolutionFault";
  }
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    result = result * 256 + value;
  }
  return result >>> 0;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: ReadonlyArray<readonly [number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];
  return !blocked.some(([base, prefix]) => inIpv4Range(value, base, prefix));
}

function ipv6Bytes(address: string): Uint8Array | null {
  if (address.includes("%") || address.split("::").length > 2) return null;
  let value = address.toLowerCase();
  const ipv4 = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4) {
    const number = ipv4Number(ipv4);
    if (number === null) return null;
    value = `${value.slice(0, -ipv4.length)}${((number >>> 16) & 0xffff).toString(16)}:${(
      number & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = Number.parseInt(groups[index]!, 16);
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function publicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const mapped =
    bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return publicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  if ((bytes[0]! & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2]! & 0xfe) === 0) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
    return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2]! & 0xf0) === 0) return false;
  return true;
}

export function isPublicNetworkAddress(address: string, family: number): boolean {
  return family === 4
    ? isIP(address) === 4 && publicIpv4(address)
    : family === 6 && isIP(address) === 6 && publicIpv6(address);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The network operation was aborted.", "AbortError");
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export const defaultNetworkResolver: NetworkResolver = async (hostname) => {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family as 4 | 6 }]
      : [],
  );
};

export interface ResolveNetworkAddressOptions {
  allowPrivateNetwork?: boolean | undefined;
  resolver?: NetworkResolver | undefined;
  signal?: AbortSignal | undefined;
}

export function networkHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export async function resolveNetworkAddress(
  url: URL,
  options: ResolveNetworkAddressOptions = {},
): Promise<ResolvedAddress> {
  const hostname = networkHostname(url);
  const literalFamily = isIP(hostname);
  let addresses: readonly ResolvedAddress[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  } else {
    const resolver = options.resolver ?? defaultNetworkResolver;
    try {
      const operation = Promise.resolve(resolver(hostname, options.signal));
      addresses = options.signal ? await abortable(operation, options.signal) : await operation;
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (error instanceof NetworkPolicyFault || error instanceof NetworkResolutionFault)
        throw error;
      throw new NetworkResolutionFault("resolution_failed", error);
    }
  }
  if (!addresses.length) throw new NetworkResolutionFault("no_addresses");
  const malformed = addresses.some(
    (entry) =>
      !entry ||
      (entry.family !== 4 && entry.family !== 6) ||
      typeof entry.address !== "string" ||
      isIP(entry.address) !== entry.family,
  );
  if (malformed) {
    if (options.allowPrivateNetwork !== true) throw new NetworkPolicyFault("private_destination");
    throw new NetworkResolutionFault("malformed_addresses");
  }
  if (
    options.allowPrivateNetwork !== true &&
    addresses.some((entry) => !isPublicNetworkAddress(entry.address, entry.family))
  )
    throw new NetworkPolicyFault("private_destination");
  return addresses[0]!;
}
