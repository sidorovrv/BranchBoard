import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDirectory } from "./dataDirectory";
import { DEFAULT_PORT, installProcessHandlers, startServer } from "./start";

installProcessHandlers();

const { accessLink } = await startServer({
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  dataDirectory: defaultDataDirectory(),
  webRoot: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist"),
  extraOrigins: (process.env.BRANCHBOARD_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
});

console.log(`Open Branchboard with this link (it holds your access key, keep it private):\n${accessLink}`);
