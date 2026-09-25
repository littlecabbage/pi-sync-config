import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// /exit — same effect as built-in /quit (graceful shutdown, deferred until agent idle)
	pi.registerCommand("exit", {
		description: "Exit pi (same as /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	// Bare "exit" typed without slash — quit instead of sending it to the model
	pi.on("input", async (event, ctx) => {
		if (event.text.trim().toLowerCase() === "exit") {
			ctx.shutdown();
			return { action: "handled" };
		}
		return { action: "continue" };
	});
}
