<p align="center">
  <img src="https://raw.githubusercontent.com/sidorovrv/BranchBoard/main/packages/web/public/favicon.svg" alt="BranchBoard logo" width="96" height="96">
</p>

<h1 align="center">BranchBoard</h1>

<p align="center">
  A whiteboard for AI chats.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/sidorovrv/BranchBoard/main/packages/web/public/readme/hero.gif" alt="A BranchBoard board for a market expansion decision: a shortlist prompt, parallel branches that each estimate customer acquisition cost for one market, and an expansion report with a scoring table" width="900">
</p>

---

BranchBoard is a whiteboard for AI chats. A board runs several chats side by side on a diagram-like canvas. Branch any answer to try another direction, and connect the answers you want to build on. It is a free, open-source local web app that uses the `claude`, `codex` or `opencode` command-line tool or an Anthropic or OpenAI API key, and your boards are stored on your machine.

## Features

- **Wires set context.** Connecting one node to another adds its context to the other node's prompt.
- **Branching.** Fork any turn to explore different options.
- **Context control.** Combine nodes' and branches' answers later to start a chat based on their combined context.
- **Code nodes.** Inspect changes and produced files right on the board. Pass them as context to other nodes with a simple connect.
- **Tables & graphs.** See and interact with tables and graphs right in the node's answer.
- **Your choice of platform.** Claude, Codex, OpenCode, Anthropic, OpenAI, OpenRouter, Ollama and LM Studio.

## Get started

Requires Node.js 22.13 or newer and one of: a signed-in `claude`, `codex` or `opencode` command, or an Anthropic or OpenAI API key.

```bash
npx branchboard
```

To install it globally, run `npm install -g branchboard` and start it with `branchboard`.

BranchBoard opens the browser with a link that contains an access key. Do not share the link.

## Options

```
branchboard [options]

  --port <number>    Port to listen on
  --data-dir <dir>   Folder for boards and logs
  --host             Accept connections from other devices on the local network
  --no-key           Open without the access key
  --no-open          Do not open the browser
  --offline          Make no internet requests
  --no-auto-update   Do not install updates at start
  -v, --version      Print the version
  -h, --help         Print this help

  update             Install the newest version
  update --check     Only report the newest version
```

Boards are stored in `%LOCALAPPDATA%\Branchboard` on Windows, `~/Library/Application Support/Branchboard` on macOS and `~/.local/share/branchboard` on Linux. To back up, stop BranchBoard and copy that folder. It also contains the access key.

## License

[MIT](LICENSE)
