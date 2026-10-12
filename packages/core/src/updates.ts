export const PACKAGE_NAME = "branchboard";
export const REPOSITORY_URL = "https://github.com/sidorovrv/BranchBoard/";
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,30})?$/;

export interface AvailableUpdate {
  version: string;
  notesUrl: string;
}

export interface UpdateTags {
  latest?: string;
}

export const updateCommand = (target: string = "latest"): string => `npm install -g ${PACKAGE_NAME}@${target}`;

export const releaseNotesUrl = (version: string): string => `${REPOSITORY_URL}releases/tag/v${version}`;

const partsOf = (version: string) => {
  const [numbers, preRelease] = version.split(/-(.*)/s);
  return { numbers: numbers.split(".").map(Number), preRelease: preRelease?.split(".") };
};

const compareIdentifiers = (left: string, right: string): number => {
  const [leftNumber, rightNumber] = [Number(left), Number(right)];
  if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) return leftNumber - rightNumber;
  return left < right ? -1 : left > right ? 1 : 0;
};

export const compareVersions = (left: string, right: string): number => {
  const [first, second] = [partsOf(left), partsOf(right)];
  const numberDifference = first.numbers.map((part, index) => part - second.numbers[index]).find((difference) => difference !== 0);
  if (numberDifference) return numberDifference;
  if (!first.preRelease || !second.preRelease) return Number(!first.preRelease) - Number(!second.preRelease);
  const length = Math.max(first.preRelease.length, second.preRelease.length);
  for (let index = 0; index < length; index++) {
    const [a, b] = [first.preRelease[index], second.preRelease[index]];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const difference = compareIdentifiers(a, b);
    if (difference) return difference;
  }
  return 0;
};

export const isNewerVersion = (candidate: string, current: string): boolean => VERSION_PATTERN.test(candidate) && VERSION_PATTERN.test(current) && compareVersions(candidate, current) > 0;

export const updateFor = ({ latest }: UpdateTags, current: string): AvailableUpdate | null =>
  latest && isNewerVersion(latest, current) ? { version: latest, notesUrl: releaseNotesUrl(latest) } : null;

export interface AboutInfo {
  version: string;
  installedVersion: string | null;
  platform: string;
  dataDirectory: string;
  update: AvailableUpdate | null;
  channelVersion: string | null;
  isUnsupported: boolean;
  minimumVersion: string | null;
  isOffline: boolean;
  checkedAt: number | null;
  checkError: string | null;
}

export type UpdateNoticeKind = "unsupported" | "restart" | "available" | "whatsNew";

export interface UpdateNotice {
  kind: UpdateNoticeKind;
  version: string;
  notesUrl: string;
}

export const updateNoticeOf = (about: AboutInfo, previousVersion: string | null): UpdateNotice | null => {
  if (about.isUnsupported) {
    const version = about.update?.version ?? about.minimumVersion ?? about.version;
    return { kind: "unsupported", version, notesUrl: releaseNotesUrl(version) };
  }
  if (about.installedVersion) return { kind: "restart", version: about.installedVersion, notesUrl: releaseNotesUrl(about.installedVersion) };
  if (about.update) return { kind: "available", ...about.update };
  if (previousVersion && VERSION_PATTERN.test(about.version) && isNewerVersion(about.version, previousVersion)) return { kind: "whatsNew", version: about.version, notesUrl: releaseNotesUrl(about.version) };
  return null;
};

export const describeUpdateStatus = (about: AboutInfo): string => {
  if (about.isOffline) return "Update checks are turned off (--offline or BRANCHBOARD_OFFLINE=1).";
  if (about.isUnsupported) return `This version is older than the oldest supported one (v${about.minimumVersion}). Update soon.`;
  if (about.installedVersion) return `v${about.installedVersion} is installed on disk. Stop Branchboard (Ctrl+C in its terminal) and start it again to use it.`;
  if (about.update) return `v${about.update.version} is available.`;
  if (!about.channelVersion) return "No published release has been found.";
  return `Up to date (latest: v${about.channelVersion}).`;
};
