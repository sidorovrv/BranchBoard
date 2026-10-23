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

## Using it

- **New chat node / New note / New file node** in the bottom toolbar, or double-click empty board space for a chat node. A chat node starts as a composer: pick model and agent, write the prompt, press Enter or Send. Drag any side or corner of a node to resize it.
- **Attachments:** use the paperclip in a composer, or drop files on the node, to bind them to that node. Drop files on empty canvas, or use the toolbar paperclip, for a standalone file node you can wire into other nodes.
- Unconnected nodes run in parallel; connected ones run in order. A node that is running, queued or upstream of one cannot be changed until the run stops.
- Drag from a node's handle onto another node to feed it. Drag onto empty canvas to create a new child. Drag an edge end to re-attach it. Select an edge and press `Delete`, or use its × button.
- Select a node to see its ancestors highlighted and its ordered context in the right panel (drag parents to reorder, × to disconnect).
- A finished node whose context differs from the one it ran with shows **context changed**. Use Regenerate to update it; every run is kept and the `‹ n/m ›` switcher shows an earlier one.
- **Composer:** type `/` for the runtime's slash commands (OpenCode's own, or the `.claude/commands` files) and `@` for workspace files and agents. The node keeps what you typed; the runtime receives the expanded command. The `v` next to Send opens **Schedule Run** to send at a set time while the page is open.
- **Subagents and todos:** a subagent appears as a dashed satellite node under its parent. Its answer is not sent to other nodes. Settings → Nodes can show subagents inside the parent instead. A todo list appears inside the node that wrote it.
- **Reader** (`Alt+R`): the selected node's whole conversation as plain text. **Pin** keeps a node from being dragged or resized. **Summarise up to here** stores a short stand-in that is sent instead of the full text whenever context has to be re-sent; a context larger than the board's share of the model window gets one automatically.
- **Code nodes** show a workspace file with git change bars, a Diff view, Markdown editing and an HTML preview. **Revert** undoes the files an agent edited.
- **Answer comments:** select text in an answer, write a comment and press Enter to collect it, then reply to the node; the comments become the new prompt. **Ask now** sends one at once. Right-click selected text for Quick branch and Save as note.
- **Trash** (top bar): deleted nodes, boards and projects stay recoverable for 30 days.
- **Board settings** (Settings → Boards): token budget, automatic summary threshold and environment variables.
- **Search** (`Ctrl+F` or the toolbar button): the Search tab of the right panel lists matches in titles, prompts, answers and tool calls with surrounding text; "This node only" limits it to the selected node. Results are sorted Latest (default) or Oldest. **Active jobs** (top bar): running and scheduled runs.
- **Help** (top bar): shortcuts guide, an interactive tour on a sample board and the usage statistics choice.
- **Runtimes:** Claude (the installed `claude` command), Codex (the installed `codex` command), OpenCode (the installed `opencode` command, version 1 or 2) and the Anthropic and OpenAI API-key runtimes.

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
