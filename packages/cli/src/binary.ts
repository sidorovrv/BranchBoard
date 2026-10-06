import { join } from "node:path";
import { defaultDataDirectory } from "../../server/src/dataDirectory";
import { extractEmbeddedWeb } from "./embeddedWeb";
import { runCli } from "./run";

const main = async () => {
  const webRoot = extractEmbeddedWeb((id) => join(defaultDataDirectory(), "web", id));
  await runCli(process.argv.slice(2), { webRoot });
};

void main();
