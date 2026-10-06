# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private vulnerability reporting: open this repository's **Security** tab, choose **Report a vulnerability**, and describe the problem. Include the version or commit, the steps to reproduce it, and what an attacker could do with it.

This is a small project maintained in spare time. Reports are read and answered on a best-effort basis; there is no guaranteed response time. Please allow a reasonable period to fix a problem before sharing details publicly.

## Supported versions

Only the latest release receives security fixes.

## What Branchboard is, for the purpose of a report

Branchboard is a local application. It runs a server on `127.0.0.1`, protected by an access key kept in the data folder and by Host and Origin checks, and it starts the `claude` or `opencode` command you already have installed with a project folder you choose as its working directory. Those agents can read and change files and run commands, so what matters most is anything that lets someone other than you drive the server, read files outside the chosen project folder, or run tools without the approval you set.

Out of scope: problems that need an attacker who can already run code as your operating-system user, and bugs in `claude` or `opencode` themselves (please report those to their authors).
