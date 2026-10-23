import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { RefusedError } from "./boards";
import { log } from "./log";

export interface PickerCommand {
  command: string;
  args: string[];
}

const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

const EXPLORER_PICKER_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class ExplorerFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogClass { }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private const uint PICK_FOLDERS = 0x20;
    private const uint FORCE_FILESYSTEM = 0x40;
    private const uint PATH_MUST_EXIST = 0x800;
    private const uint FILESYSPATH = 0x80058000;
    private const int CANCELLED = unchecked((int)0x800704C7);

    public static string Pick(string title, bool folders)
    {
        IFileDialog dialog = (IFileDialog)new FileOpenDialogClass();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | (folders ? PICK_FOLDERS : 0) | FORCE_FILESYSTEM | PATH_MUST_EXIST);
        dialog.SetTitle(title);
        int result = dialog.Show(GetForegroundWindow());
        if (result == CANCELLED) return "";
        Marshal.ThrowExceptionForHR(result);
        IShellItem item;
        dialog.GetResult(out item);
        string path;
        item.GetDisplayName(FILESYSPATH, out path);
        return path;
    }
}
`;

export type PickKind = "folder" | "file";

const TITLES: Record<PickKind, string> = { folder: "Choose a workspace folder", file: "Choose a file" };

const windowsScript = (kind: PickKind) => `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @"
${EXPLORER_PICKER_SOURCE}
"@
[Console]::Out.Write([ExplorerFolderPicker]::Pick("${TITLES[kind]}", ${kind === "folder" ? "$true" : "$false"}))
`;

const appleScriptQuoted = (text: string) => `"${text.replace(/[\\"]/g, "\\$&")}"`;

export const pickerCommands = (platform: NodeJS.Platform, kind: PickKind = "folder", start: string = homedir()): PickerCommand[] => {
  const title = TITLES[kind];
  const isFolder = kind === "folder";
  const startWithSlash = /[\\/]$/.test(start) ? start : `${start}/`;
  if (platform === "win32")
    return [{ command: "powershell.exe", args: ["-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(windowsScript(kind), "utf16le").toString("base64")] }];
  if (platform === "darwin") {
    return [{ command: "osascript", args: ["-e", `POSIX path of (choose ${isFolder ? "folder" : "file"} with prompt ${appleScriptQuoted(title)} default location (POSIX file ${appleScriptQuoted(start)}))`] }];
  }
  return [
    { command: "zenity", args: ["--file-selection", "--modal", ...(isFolder ? ["--directory"] : []), `--title=${title}`, `--filename=${startWithSlash}`] },
    { command: "kdialog", args: [isFolder ? "--getexistingdirectory" : "--getopenfilename", start, "--title", title] },
  ];
};

export const cleanSelection = (output: string): string | undefined => {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 1 && /[\\/]$/.test(trimmed) && !/^[A-Za-z]:[\\/]$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
};

type RunOutcome = { kind: "selected"; path: string | undefined } | { kind: "missing" } | { kind: "failed"; message: string };

const RAISE_DELAY_MS = 300;
const RAISE_TIMEOUT_MS = 5000;

const raiseCommands = (title: string, pid: number): PickerCommand[] => [
  { command: "xdotool", args: ["search", "--sync", "--onlyvisible", "--pid", String(pid), "windowactivate"] },
  { command: "wmctrl", args: ["-a", title] },
];

const raiseWith = ([first, ...rest]: PickerCommand[]) => {
  if (first) execFile(first.command, first.args, { timeout: RAISE_TIMEOUT_MS }, (error) => error && raiseWith(rest));
};

const raiseWindow = (title: string, pid: number) => setTimeout(() => raiseWith(raiseCommands(title, pid)), RAISE_DELAY_MS);

const run = ({ command, args }: PickerCommand, title: string): Promise<RunOutcome> =>
  new Promise((resolve) => {
    const child = execFile(command, args, { timeout: PICKER_TIMEOUT_MS, windowsHide: false }, (error, stdout, stderr) => {
      if (stderr.trim()) log.warn("folder-picker", `${command} wrote to stderr`, stderr.trim());
      if (!error) return resolve({ kind: "selected", path: cleanSelection(stdout) });
      const code: unknown = error.code;
      if (code === "ENOENT") return resolve({ kind: "missing" });
      if (code === 1 && !stdout.trim()) return resolve({ kind: "selected", path: undefined });
      log.error("folder-picker", `${command} failed (code ${code}, signal ${error.signal}, killed ${error.killed})`, error);
      resolve({ kind: "failed", message: stderr.trim() || error.message });
    });
    log.debug("folder-picker", `Spawned ${command} pid ${child.pid}`);
    if (process.platform === "linux" && child.pid) raiseWindow(title, child.pid);
    child.stdin?.end();
  });

export const pickPath = async (kind: PickKind, start?: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> => {
  const candidates = pickerCommands(platform, kind, start && existsSync(start) ? start : homedir());
  for (const candidate of candidates) {
    const outcome = await run(candidate, TITLES[kind]);
    if (outcome.kind === "selected") return outcome.path;
    if (outcome.kind === "failed") throw new RefusedError(`File dialog failed: ${outcome.message}`);
    log.warn("folder-picker", `${candidate.command} is not installed`);
  }
  throw new RefusedError(`No file dialog is available (tried ${candidates.map((candidate) => candidate.command).join(", ")}). Install one or type the path.`);
};
