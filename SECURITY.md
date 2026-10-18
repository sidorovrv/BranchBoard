# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private vulnerability reporting: open this repository's **Security** tab, choose **Report a vulnerability**, and describe the problem. Include the version or commit, the steps to reproduce it, and what an attacker could do with it.

This is a small project maintained in spare time. Reports are read and answered on a best-effort basis; there is no guaranteed response time. Please allow a reasonable period to fix a problem before sharing details publicly.

## Supported versions

Only the latest release receives security fixes.

## What Branchboard is, for the purpose of a report

Branchboard is a local application. It runs a server on `127.0.0.1`, protected by an access key kept in the data folder and by Host and Origin checks, and it starts the `claude`, `codex` or `opencode` command you already have installed with a project folder you choose as its working directory. Those agents can read and change files and run commands, so what matters most is anything that lets someone other than you drive the server, read files outside the chosen project folder, or run tools without the approval you set.

Out of scope: problems that need an attacker who can already run code as your operating-system user, and bugs in `claude`, `codex` or `opencode` themselves (please report those to their authors).

## Usage statistics

Branchboard asks once, after your 25th successful run, whether to send aggregated anonymous usage counts. Nothing is sent until you choose "Sure, share aggregated anonymous telemetry". Switch it off any time in Settings → Version and updates.

- **What is sent:** once per finished local day, one payload of counts and app facts: app version, operating system, Node major version, days active in the last 7 and 28 days, number of boards, nodes created per kind, runs per outcome, runtime, context mode and failure type, deepest branch, max and average branches per node and undo steps. Settings shows today's counts under "Show what is sent".
- **What is not sent:** prompts, answers, file names, paths, board or project names, identifiers of boards or nodes, error text and any install id. Each payload has a random `payloadId` that is new for every payload and is used only to discard a duplicate delivery.
- **Receiver:** a Cloudflare Worker with a D1 database (`services/telemetry-worker`) that stores the payload and the receive date. It does not read or store the request IP or headers, and Workers Logs are off. Cloudflare processes your IP address to route the request.
- **Consent:** stored in `telemetry.json` in the data folder, with the time and the version of the decision. Updates and browser settings do not change it.
- **Log:** every payload is appended to `telemetry-sent.jsonl` in the data folder with the send time and the HTTP status.
- **Offline:** `--offline` and `BRANCHBOARD_OFFLINE=1` send nothing. Counting on this computer continues.
