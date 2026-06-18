import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { frontdoorAuth } from "../lib/frontdoor-auth.ts";

export default eveChannel({
	auth: [frontdoorAuth(), localDev(), vercelOidc()],
});

