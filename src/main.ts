import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Reply, View } from "./contracts";
import { InputError, Store } from "./store";

const windows = new Map<View, BrowserWindow>();
let store: Store | undefined;
const page = join(__dirname, "../ui/index.html");

function showWindow(view: View): BrowserWindow {
  const existing = windows.get(view);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const compact = view === "panel";
  const win = new BrowserWindow({
    title: compact ? "Session Tape · Quick note" : "Session Tape",
    width: compact ? 390 : 880, height: compact ? 390 : 760,
    minWidth: compact ? 330 : 470, minHeight: compact ? 320 : 480,
    show: false, backgroundColor: "#f5f0e5", autoHideMenuBar: true,
    alwaysOnTop: compact && (process.platform !== "linux" || process.env.XDG_SESSION_TYPE === "x11"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  windows.set(view, win);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => windows.delete(view));
  void win.loadFile(page, { query: { view } }).catch(() => {
    if (!win.isDestroyed()) {
      dialog.showErrorBox("Session Tape", "The bundled window could not be opened.");
      win.destroy();
    }
  });
  return win;
}

function register<T>(channel: string, run: (payload: unknown) => T, changes = false): void {
  ipcMain.handle(channel, (event, payload: unknown): Reply<T> => {
    const trusted = [...windows.entries()].some(([view, win]) =>
      win.webContents === event.sender && event.senderFrame === win.webContents.mainFrame &&
      event.senderFrame.url === pathToFileURL(page).href + "?view=" + view
    );
    if (!trusted) return { ok: false, error: "Unrecognized application window." };
    try {
      const value = run(payload);
      if (changes) {
        for (const win of windows.values()) win.webContents.send("archive:changed");
      }
      return { ok: true, value };
    } catch (error) {
      const message = error instanceof InputError ? error.message : "The operation failed. Check local storage and try again.";
      return { ok: false, error: message };
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (app.isReady() && store) showWindow("archive"); });
  app.whenReady().then(() => {
    const db = new Store(join(app.getPath("userData"), "session-tape.sqlite"));
    store = db;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    register("archive:snapshot", query => db.snapshot(query));
    register("session:events", query => db.sessionEvents(query));
    register("session:start", title => db.start(title), true);
    register("session:phase", input => db.changePhase(input), true);
    register("session:finish", id => db.finish(id), true);
    register("note:add", note => db.addNote(note), true);
    register("note:edit", note => db.editNote(note), true);
    register("window:show", view => {
      if (view !== "archive" && view !== "panel") throw new InputError("Unknown window.");
      showWindow(view);
    });
    const archive = showWindow("archive");
    const copy = db.upgradeCopyPath;
    if (copy) {
      archive.once("ready-to-show", () => {
        void dialog.showMessageBox(archive, {
          type: "info", title: "Session Tape", message: "Archive upgraded",
          detail: `A recovery copy containing your notes and edit history is saved here.\n\n${copy}\n\n` +
            "This file is unencrypted. After checking your upgraded archive, you can keep the copy or delete it.",
          buttons: ["OK"],
        });
      });
    }
    app.on("activate", () => showWindow("archive"));
  }).catch(error => {
    const reason = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Could not open Session Tape", reason + "\n\n" +
      `Check free disk space and write access to the data folder, then retry.\n${app.getPath("userData")}\n\n` +
      "To access an existing archive after a failed upgrade, use the app version that last opened it successfully.");
    app.quit();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => store?.close());
}
