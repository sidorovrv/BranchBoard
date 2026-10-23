import { VERSION_PATTERN } from "./updates";

export const CHANNEL_SOURCE_URL = "https://raw.githubusercontent.com/sidorovrv/BranchBoard/main/channel.json";
export const UPDATE_CHECK_PATH = "/v1/channel";

export const UPDATE_CHECK_OSES = ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"] as const;
export const UPDATE_CHECK_ARCHITECTURES = ["arm", "arm64", "ia32", "ppc64", "riscv64", "s390x", "x64"] as const;
export const UPDATE_CHECK_INSTALLS = ["npm", "npx"] as const;

const NODE_MAJOR_PATTERN = /^\d{1,3}$/;

export interface UpdateCheck {
  version: string;
  os: string;
  arch: string;
  nodeMajor: number;
  install: string;
  autoUpdate: boolean;
  first: boolean;
}

const flagOf = (value: string | null): boolean | undefined => (value === "1" ? true : value === "0" ? false : undefined);

const choiceOf = <T extends string>(choices: readonly T[], value: string | null): T | undefined => choices.find((choice) => choice === value);

export const updateCheckQuery = ({ version, os, arch, nodeMajor, install, autoUpdate, first }: UpdateCheck): string =>
  new URLSearchParams({ v: version, os, arch, node: String(nodeMajor), install, auto: autoUpdate ? "1" : "0", first: first ? "1" : "0" }).toString();

export const parseUpdateCheck = (params: URLSearchParams): UpdateCheck | undefined => {
  const version = params.get("v");
  const node = params.get("node");
  const os = choiceOf(UPDATE_CHECK_OSES, params.get("os"));
  const arch = choiceOf(UPDATE_CHECK_ARCHITECTURES, params.get("arch"));
  const install = choiceOf(UPDATE_CHECK_INSTALLS, params.get("install"));
  const autoUpdate = flagOf(params.get("auto"));
  const first = flagOf(params.get("first"));
  const isKnown = version !== null && VERSION_PATTERN.test(version) && node !== null && NODE_MAJOR_PATTERN.test(node);
  if (!isKnown || !os || !arch || !install || autoUpdate === undefined || first === undefined) return undefined;
  return { version, os, arch, nodeMajor: Number(node), install, autoUpdate, first };
};

export const sendableUpdateCheckQuery = (check: UpdateCheck): string | undefined => {
  const query = updateCheckQuery(check);
  return parseUpdateCheck(new URLSearchParams(query)) ? query : undefined;
};
