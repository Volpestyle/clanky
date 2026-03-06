const STREAM_INGEST_API_PATH = "/voice/stream-ingest/frame";
const PUBLIC_API_HEADER_ALLOWLIST = new Set([STREAM_INGEST_API_PATH, `${STREAM_INGEST_API_PATH}/`]);
const SHARE_SESSION_TOKEN_PATH_RE =
  /^\/voice\/share-session\/[a-z0-9_-]{16,}\/(?:frame|stop)\/?$/i;

const API_ACCESS_KIND = {
  private: "private",
  publicHeaderToken: "public_header_token",
  publicSessionToken: "public_session_token"
};

export function normalizeHost(rawHost) {
  return String(rawHost || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export function getPublicTunnelHost(publicHttpsState) {
  const url = String(publicHttpsState?.publicUrl || "").trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return normalizeHost(parsed.host);
  } catch {
    return "";
  }
}

export function isPublicTunnelRequestHost(requestHost, publicHttpsState) {
  const normalizedRequestHost = normalizeHost(requestHost);
  if (!normalizedRequestHost) return false;
  const tunnelHost = getPublicTunnelHost(publicHttpsState);
  if (!tunnelHost) return false;
  return normalizedRequestHost === tunnelHost;
}

export function isAllowedPublicApiPath(apiPath) {
  const kind = classifyApiAccessPath(apiPath);
  return kind !== API_ACCESS_KIND.private;
}

export function classifyApiAccessPath(apiPath) {
  const path = String(apiPath || "");
  if (PUBLIC_API_HEADER_ALLOWLIST.has(path)) return API_ACCESS_KIND.publicHeaderToken;
  if (SHARE_SESSION_TOKEN_PATH_RE.test(path)) return API_ACCESS_KIND.publicSessionToken;
  return API_ACCESS_KIND.private;
}

export function isPublicSessionTokenApiPath(apiPath) {
  return classifyApiAccessPath(apiPath) === API_ACCESS_KIND.publicSessionToken;
}
