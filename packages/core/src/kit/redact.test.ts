import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "./redact";

const awsAccessKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const bearerToken = ["abcdefgh", "12345678"].join("");

describe("secret redaction", () => {
  it("replaces known key shapes, the access key and the home folder", () => {
    const text = [
      "key sk-ant-abcdefghijkl1234 and sk-abcdefghijklmnopqrstu",
      `token ghp_abcdefghijklmnopqrstuvwx and ${awsAccessKey}`,
      `Authorization: Bearer ${bearerToken}`,
      "link http://127.0.0.1:4777/?access=SECRETACCESSKEY&x=1",
      "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
      "file C:\\Users\\Casey\\Desktop\\a.txt and C:/Users/Casey/b.txt",
      "literal hunter2hunter2",
    ].join("\n");
    const redacted = redactSecrets(text, { secrets: ["hunter2hunter2"], homeDirectory: "C:\\Users\\Casey" });
    ["sk-ant-abcdefghijkl1234", "sk-abcdefghijklmnopqrstu", "ghp_abcdefghijklmnopqrstuvwx", awsAccessKey, bearerToken, "SECRETACCESSKEY", "MIIabc", "Casey", "hunter2hunter2"].forEach(
      (secret) => expect(redacted).not.toContain(secret),
    );
    expect(redacted).toContain("~\\Desktop\\a.txt");
    expect(redacted).toContain("~/b.txt");
    expect(redacted).toContain("?access=[redacted]&x=1");
  });

  it("redacts every string inside nested values", () => {
    const redacted = redactDeep({ list: ["Bearer abcdefgh12345678", { note: "plain" }], count: 2 });
    expect(redacted).toEqual({ list: ["[redacted]", { note: "plain" }], count: 2 });
  });
});
