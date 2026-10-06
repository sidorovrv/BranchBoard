#!/usr/bin/env node
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Branchboard needs Node.js 22.13 or newer; this is ${process.versions.node}. Install the current LTS from https://nodejs.org and try again.`);
  process.exit(1);
}

await import("../dist/branchboard.mjs");
