import { eveChannel } from "eve/channels/eve";
import { vercelOidc } from "eve/channels/auth";
import { frontdoorAuth, localUserAuth } from "../lib/frontdoor-auth.ts";
import { ensurePushWatcherIfRegistered } from "../lib/push-watcher.ts";

const MAX_EVE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

// Channel modules load at brain boot, so restart the push watcher here: relay's
// register-push op only starts it lazily, which never re-fires for already-
// registered phones after a restart. No-op when the registry is empty;
// idempotent alongside relay's lazy start.
void ensurePushWatcherIfRegistered();

// Auth walk: bearer token first, then socket-verified loopback for the local
// face. eve's localDev() is intentionally absent — it trusts the client-
// controlled Host header, which a tailnet caller can spoof to "localhost";
// localUserAuth() covers genuinely-local callers via the socket remote address.
export default eveChannel({
	auth: [frontdoorAuth(), localUserAuth(), vercelOidc()],
	uploadPolicy: { maxBytes: MAX_EVE_ATTACHMENT_BYTES },
});
