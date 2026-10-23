import { spawn } from "node:child_process";
import { PACKAGE_NAME, isNewerVersion, updateCommand } from "@branchboard/core";
import { TAGS_URL, defaultFetchText, parseTags, type FetchText } from "../../server/src/channel";
import { currentInstallKind, installKindOf, type InstallKind } from "../../server/src/installKind";
import { VERSION } from "../../server/src/version";
import type { UpdateArguments } from "./args";

export { installKindOf };

export interface UpdateDependencies {
  fetchText: FetchText;
  install: (version: string) => Promise<number>;
  installKind: InstallKind;
  print: (line: string) => void;
}

const installWithNpm = (stdio: "inherit" | "ignore") => (version: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", `${PACKAGE_NAME}@${version}`], { stdio, shell: process.platform === "win32" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });

export const defaultUpdateDependencies = (stdio: "inherit" | "ignore" = "inherit"): UpdateDependencies => ({
  fetchText: defaultFetchText(),
  install: installWithNpm(stdio),
  installKind: currentInstallKind(),
  print: (line) => console.log(line),
});

export const runUpdate = async ({ isCheckOnly }: UpdateArguments, dependencies: UpdateDependencies = defaultUpdateDependencies(), current: string = VERSION): Promise<number> => {
  const { fetchText, install, installKind, print } = dependencies;
  const target = await fetchText(TAGS_URL).then(
    (text) => parseTags(JSON.parse(text)).latest,
    (error: Error) => (print(`Could not reach the update server: ${error.message}`), null),
  );
  if (target === null) return 1;
  if (!target) return print("No published release was found."), 1;
  if (!isNewerVersion(target, current)) return print(`Branchboard ${current} is up to date (latest: ${target}).`), 0;
  if (isCheckOnly) return print(`Branchboard ${current}; ${target} is available. Update with: ${PACKAGE_NAME} update`), 0;
  if (installKind === "npx") return print(`This copy was started through npx. Start the new one with: npx ${PACKAGE_NAME}@${target}`), 0;
  if (installKind === "source") return print(`This copy does not come from npm. Update the checkout with git pull, then npm install and npm run build. The published version is ${target}.`), 1;
  print(`Installing ${target} with: ${updateCommand(target)}`);
  if ((await install(target)) !== 0) return print(`The install failed. Run it yourself: ${updateCommand(target)}`), 1;
  print(`Updated ${current} to ${target}. Stop any running Branchboard (Ctrl+C), then start it again to use the new version.`);
  return 0;
};

export const shouldAutoUpdate = (parsed: { shouldAutoUpdate: boolean; offline?: true }, installKind: InstallKind = defaultUpdateDependencies().installKind): boolean =>
  parsed.shouldAutoUpdate && !parsed.offline && installKind === "npm" && process.env.BRANCHBOARD_OFFLINE !== "1" && process.env.BRANCHBOARD_AUTOUPDATE !== "0";

export const runAutoUpdate = (): Promise<number> => runUpdate({ kind: "update", isCheckOnly: false }, defaultUpdateDependencies("ignore"));
