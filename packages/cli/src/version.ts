declare const __BRANCHBOARD_VERSION__: string | undefined;

export const VERSION = typeof __BRANCHBOARD_VERSION__ === "string" ? __BRANCHBOARD_VERSION__ : "development";
