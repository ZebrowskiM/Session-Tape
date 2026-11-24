# Session Tape

A local desktop notebook for debugging and research. Start a named session, save a timestamped note from the archive or compact panel, edit saved notes in the archive, and review their timestamped version history. Find notes later by session title or note text. Both windows use the same SQLite database.

## Run locally

Use Node.js **24.13 or newer in the 24.x series** with npm 11. The included `.nvmrc` pins the version used to verify the starter. Extract the source ZIP and open a terminal in the folder containing `package.json`.

```sh
npm ci
npm start
```

The first setup and Electron runtime download need internet access. After installation, the running app reads and writes local files. On Linux, run the desktop app from a graphical session.

## Try the first workflow

1. In the archive, start a session named **CSV import**.
2. Select **Open panel**, type “Only the delivery dates were blank,” and press **Ctrl+Enter** or **Cmd+Enter**. Wait for **Note saved**.
3. Return to the archive and search for **delivery**. The note shows its session and local display time. Use **Edit** to update it; its earlier text and save time remain in version history.
4. Close both windows and relaunch. The active session and saved note are restored. **Finish session** closes it to new entries and keeps its notes searchable.

Draft text stays in the editing window until saved. Closing the window discards that unsaved text. The archive shows the newest 100 matching notes. Search uses literal substrings and SQLite’s built-in case folding. The compact panel requests always-on-top on Windows, macOS and Linux X11. The archive contains the same editor on Wayland.

## Develop and package

| Command | Result |
| --- | --- |
| `npm run build` | Type-check and compile the TypeScript into `dist/`. |
| `npm test` | Build and run the SQLite persistence, validation and retry tests in temporary profiles. |
| `npm run package` | Produce a runnable application directory for the current platform under `out/`. |
| `npm run make` | Produce a host-platform application ZIP under `out/make/`. |

The main process owns both windows and the database. It uses `node:sqlite` supplied by the pinned Electron runtime, so the starter has no separate native SQLite dependency to rebuild. Each note has a client-generated ID to make a retry safe if a save acknowledgement is lost. The renderer uses a typed preload bridge, bundled resources, context isolation and sandboxed windows.

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Desktop lifecycle, window creation, sender checks and IPC handlers |
| `src/contracts.ts`, `src/preload.ts` | Shared types and the window API |
| `src/store.ts` | Versioned SQLite schema, sessions, notes and search |
| `src/renderer.ts`, `ui/` | Archive, compact panel, keyboard entry and status feedback |
| `test/store.test.cjs` | File-backed database regression tests |
| `forge.config.cjs` | Host-platform application packaging and ZIP artifacts |

User data lives in `session-tape.sqlite` inside Electron’s per-user application-data folder for **Session Tape**. The app stores timestamps in UTC and displays them in the local time zone. Local storage relies on the device for at-rest protection.

## Next milestones

1. Add durable draft autosave, elapsed time, focus/break transitions and explicit gap handling after sleep.
2. Add manual snip attachments, FTS5 indexing and exact replay markers.
3. Add linked corrections, readable exports and portable backup/restore.

## License

Session Tape is available under the [MIT License](LICENSE). Copyright (c) 2026 Marek Zebrowski. See [contributing](CONTRIBUTING.md) for the local workflow.
