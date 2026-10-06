import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./run";

await runCli(process.argv.slice(2), { webRoot: join(dirname(fileURLToPath(import.meta.url)), "web") });
