import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { frontdoorAuth, localUserAuth } from "../lib/frontdoor-auth.ts";

const MAX_EVE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export default eveChannel({
	auth: [frontdoorAuth(), localUserAuth(), localDev(), vercelOidc()],
	uploadPolicy: { maxBytes: MAX_EVE_ATTACHMENT_BYTES },
});
