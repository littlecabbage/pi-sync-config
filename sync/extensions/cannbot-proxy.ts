import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The local gateway accepts anonymous requests but rejects dummy Bearer keys. */
export default function (pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== "cannbot") return;
    if (ctx.model.baseUrl !== "http://127.0.0.1:8088/v1") return;
    for (const key of Object.keys(event.headers)) {
      if (key.toLowerCase() === "authorization") event.headers[key] = null;
    }
    event.headers.Authorization = null;
  });
}
