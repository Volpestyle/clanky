import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIp(value) {
  const ipType = net.isIP(String(value || ""));
  if (!ipType) return false;

  if (ipType === 4) {
    const parts = String(value || "")
      .split(".")
      .map((part) => Number(part || 0));
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }

  const compact = String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (compact === "::1") return true;
  if (compact.startsWith("fc") || compact.startsWith("fd")) return true;
  return compact.startsWith("fe80");
}

export function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local")) return true;
  return isPrivateIp(host);
}

export async function assertPublicUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || ""));
  const host = String(parsed.hostname || "").toLowerCase();
  if (isBlockedHost(host)) {
    throw new Error(`blocked host: ${host}`);
  }

  const records = await dns.lookup(host, { all: true });
  for (const record of records) {
    if (isPrivateIp(record?.address)) {
      throw new Error(`blocked private address for host ${host}`);
    }
  }
}
