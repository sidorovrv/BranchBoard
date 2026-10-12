<p align="center">
  <img src="https://raw.githubusercontent.com/sidorovrv/BranchBoard/main/packages/web/public/favicon.svg" alt="Branchboard logo" width="96" height="96">
</p>

<h1 align="center">Branchboard</h1>

<p align="center">
  A whiteboard diagram-style canvas for AI chats.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/sidorovrv/BranchBoard/main/packages/web/public/readme/board.png" alt="A Branchboard board with a license file, a chat about popular open source licenses and three follow-up branches wired together" width="900">
</p>

---

Branchboard is a local web app that uses the `claude` or `opencode` command-line tool. A board runs several chats side by side on a diagram-like canvas. Fork a turn to try another direction and connect the answers you want to build on. Boards are stored on your machine.

## Features

- **Wires set context.** Connecting one node to another adds its context to the other node's prompt.
- **Branching.** Fork any turn to explore different options.
- **Context control.** Combine nodes' and branches' answers later to start a chat based on their combined context.
- **Code nodes.** Inspect changes and produced files right on the board. Pass them as context to other nodes with a simple connect.
- **Tables & graphs.** See and interact with tables and graphs right in the node's answer.

## Get started

Requires Node.js 22.13 or newer and a signed-in `claude` or `opencode` command.

```bash
npx branchboard
```

To install it globally, run `npm install -g branchboard` and start it with `branchboard`.

Branchboard opens the browser with a link that contains an access key. Do not share the link.

Create a project, pick its folder and choose a runtime: Claude or OpenCode.

## Options

```
branchboard [options]

  --port <number>    Port to listen on
  --data-dir <dir>   Folder for boards and logs
  --no-open          Do not open the browser
  --offline          Make no internet requests
  --no-auto-update   Do not install updates at start
  -v, --version      Print the version
  -h, --help         Print this help

  update             Install the newest version
  update --check     Only report the newest version
```

Boards are stored in `%LOCALAPPDATA%\Branchboard` on Windows, `~/Library/Application Support/Branchboard` on macOS and `~/.local/share/branchboard` on Linux. To back up, stop Branchboard and copy that folder. It also contains the access key.

## Runtimes

- **Claude:** runs the installed `claude` command with your existing sign-in. Branchboard does not read or store its credentials. See Anthropic's [legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance) for third-party tools.
- **OpenCode:** runs the installed `opencode` command.

## License

[MIT](LICENSE)
