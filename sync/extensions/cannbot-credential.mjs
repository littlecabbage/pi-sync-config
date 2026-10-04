import { loadCredentials } from "./cannbot-proxy.ts";

const kind = process.argv[2];
const creds = await loadCredentials();
const value = kind === "vk" ? creds.vk : creds.jwt;
if (!value) process.exit(1);
process.stdout.write(value);
