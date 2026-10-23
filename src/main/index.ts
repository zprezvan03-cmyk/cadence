/**
 * Cadence desktop shell (Electron main process). Written for Cadence.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, Menu, shell } from "electron";
import type { AppInfo, MediaCommand } from "../shared/types";
import { IPC } from "../shared/types";
import { registerIpc } from "./ipc";
import { LibraryController } from "./library/controller";
import { LyricsCache } from "./lyrics/cache";
import { LyricsService } from "./lyrics/service";
import { MediaAllowlist, registerMediaProtocol, registerMediaScheme, toMediaUrl } from "./protocol";
import { SettingsStore } from "./settings";

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

function log(line: string): void {
  console.log(line);
  try {
    const directory = join(app.getPath("userData"), "logs");
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "main.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never take the app down */
  }
}

process.on("uncaughtException", error => log(`[uncaughtException] ${error.stack ?? error.message}`));
process.on("unhandledRejection", reason => log(`[unhandledRejection] ${String(reason)}`));

// Must be called before `app.whenReady()`.
registerMediaScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

function sendCommand(command: MediaCommand): void {
  mainWindow?.webContents.send(IPC.playerCommand, command);
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Add music folder…",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("menu:add-folder"),
        },
        {
          label: "Rescan library",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => mainWindow?.webContents.send("menu:rescan"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Playback",
      submenu: [
        { label: "Play / Pause", accelerator: "CmdOrCtrl+P", click: () => sendCommand("play-pause") },
        { label: "Next", accelerator: "CmdOrCtrl+Right", click: () => sendCommand("next") },
        { label: "Previous", accelerator: "CmdOrCtrl+Left", click: () => sendCommand("previous") },
        { type: "separator" },
        { label: "Seek forward", accelerator: "CmdOrCtrl+Up", click: () => sendCommand("seek-forward") },
        { label: "Seek back", accelerator: "CmdOrCtrl+Down", click: () => sendCommand("seek-back") },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Better Lyrics on GitHub",
          click: () => void shell.openExternal("https://github.com/better-lyrics/better-lyrics"),
        },
        {
          label: "Better Lyrics Shaders on GitHub",
          click: () => void shell.openExternal("https://github.com/better-lyrics/shaders"),
        },
        { type: "separator" },
        {
          label: `Cadence ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerMediaKeys(): void {
  if (process.platform === "darwin") return; // macOS routes media keys to the app through Now Playing
  const bindings: [string, MediaCommand][] = [
    ["MediaPlayPause", "play-pause"],
    ["MediaNextTrack", "next"],
    ["MediaPreviousTrack", "previous"],
    ["MediaStop", "stop"],
  ];
  for (const [accelerator, command] of bindings) {
    try {
      const registered = globalShortcut.register(accelerator, () => sendCommand(command));
      if (!registered) log(`[media-keys] could not register ${accelerator} (held by the desktop)`);
    } catch (error) {
      log(`[media-keys] ${accelerator} failed: ${(error as Error).message}`);
    }
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: "#08080b",
    title: "Cadence",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  if (process.env.CADENCE_OPEN_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
}

async function boot(): Promise<void> {
  const userData = app.getPath("userData");
  log(`[boot] userData=${userData} dev=${isDev}`);

  const settings = new SettingsStore(join(userData, "settings.json"));
  const allowlist = new MediaAllowlist();
  const library = new LibraryController(
    { dbPath: join(userData, "library.db"), artworkDirectory: join(userData, "artwork") },
    allowlist,
    (path: string, isArtwork?: boolean) => toMediaUrl(path, isArtwork ? "art" : "file")
  );
  const lyricsCache = new LyricsCache(join(userData, "cache", "lyrics.json"));
  const lyrics = new LyricsService(library.store, lyricsCache);

  registerMediaProtocol({ allowlist, artworkDirectory: library.artworkDirectory });

  const info: AppInfo = {
    name: "Cadence",
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    dbEngine: library.engine,
    mediaProtocol: "cadence-media://",
  };

  registerIpc({
    library,
    lyrics,
    settings,
    info,
    getWindow: () => mainWindow,
    isWindowFullScreen: () => mainWindow?.isFullScreen() ?? false,
    setFullScreen: value => mainWindow?.setFullScreen(value),
  });

  library.on("progress", progress => {
    mainWindow?.webContents.send(IPC.libraryProgress, progress);
  });
  library.on("changed", () => {
    mainWindow?.webContents.send(IPC.libraryChanged);
  });

  buildMenu();
  await createWindow();
  registerMediaKeys();

  app.on("before-quit", () => {
    settings.save();
    lyricsCache.flush();
    lyrics.flush();
    library.close();
    globalShortcut.unregisterAll();
  });

  // Scan quietly in the background so a restart picks up files added outside the app.
  setTimeout(() => {
    void library.rescan(false).catch(error => log(`[scan] ${(error as Error).stack ?? error}`));
  }, 800);
}

app.whenReady().then(boot).catch(error => {
  log(`[fatal] ${(error as Error).stack ?? String(error)}`);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
