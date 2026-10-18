import { defaultSchema } from "rehype-sanitize";

const DRIVE_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

export const sanitizeSchema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, "*": [...(defaultSchema.attributes?.["*"] ?? []), "align"] },
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "file", ...DRIVE_LETTERS] },
};
