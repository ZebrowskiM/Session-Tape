# Session Tape

Session Tape is a local-first desktop notebook for documenting the human decisions behind AI-assisted code, research, and document review. Write down what was suggested, what you checked, and what you decided so someone else can follow your reasoning later.

**Available now:** named sessions, timestamped notes from the archive or compact panel, searchable notes, and timestamped version history. Both windows use the same local SQLite database. Timeline replay, linked corrections, and export verification are planned.

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

## Example: fictional CSV handoff

A readable sample of the longer handoff story — original snip caption, decision to keep both orders, and a separately dated correction — lives in [`examples/csv-handoff/report.md`](examples/csv-handoff/report.md). Open that report alone and identify the decision and the correction (including which earlier event the correction references). All data there is invented. The snip graphic is a **design preview**, not a screenshot of a shipping feature.

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

### Recover an archive after an upgrade failure

Before upgrading an existing v1 or v2 archive, Session Tape saves a verified SQLite copy beside the live database. For a v2 archive the filename is `session-tape.sqlite.before-v2-upgrade.sqlite`. This file contains your notes and edit history, including committed changes in the SQLite write-ahead log. Each retry replaces the copy for that schema version only after verifying the new one. You can remove the recovery copy after checking the upgraded archive.

If an upgrade fails, the app shows the error and, when available, the verified copy's path. Use these steps to recover the archive.

1. Quit Session Tape. Move `session-tape.sqlite` and any adjacent `session-tape.sqlite-wal`, `session-tape.sqlite-shm` or `session-tape.sqlite-journal` files together into a separate folder for safekeeping.
2. Copy the verified pre-upgrade file to the original folder and name the **copy** `session-tape.sqlite`.
3. Open the restored copy with the app version that last read it successfully. To retry with the newer build, first address the reported error.

## Next milestones

The goal is a reviewable record of human judgment, not an AI detector. Start with one end-to-end workflow: record a suggestion, the evidence you checked, and your decision; revisit it later; add a correction without rewriting the original; and share a report someone can read without the app.

1. **Capture the decision as you work.** Build on the existing notes with an [ordered session log](https://github.com/ZebrowskiM/Session-Tape/issues/1) and [draft recovery](https://github.com/ZebrowskiM/Session-Tape/issues/5). Start with optional prompts for what AI suggested, what you checked, and what you accepted, changed, or rejected and why. Keep capture manual; a draft is not a recorded decision. Mark uncertain time after [sleep or clock changes](https://github.com/ZebrowskiM/Session-Tape/issues/3) rather than inventing activity.
2. **Revisit and correct without erasing the record.** Start with a chronological view of saved notes and [linked corrections](https://github.com/ZebrowskiM/Session-Tape/issues/10). Preserve the original across restarts and give each correction its own date. Test the text workflow against the fictional CSV example and extend it to [manual snips](https://github.com/ZebrowskiM/Session-Tape/issues/6) and [note history](https://github.com/ZebrowskiM/Session-Tape/issues/8). Keep full keyboard-accessible [timeline replay](https://github.com/ZebrowskiM/Session-Tape/issues/9) and richer [search](https://github.com/ZebrowskiM/Session-Tape/issues/7) on the roadmap without making them prerequisites for the first readable report.
3. **Share only what the reader needs.** Start with an offline [Markdown report](https://github.com/ZebrowskiM/Session-Tape/issues/11), then [PDF](https://github.com/ZebrowskiM/Session-Tape/issues/12) from the same report model. Preview the contents, allow sensitive notes or attachments to be omitted, and label partial exports. Keep unsaved drafts and local file paths out; verify that correction links still work after moving the bundle. Use the [next-day handoff pilot](https://github.com/ZebrowskiM/Session-Tape/issues/25) to check that someone with only the report can explain the decision, its rationale, and the later correction.
4. **Detect changes after export.** Under [local data controls and provenance](https://github.com/ZebrowskiM/Session-Tape/issues/15), hash the final report ZIP (report and included attachments) with SHA-256 and save the digest separately. An offline check should report **matches**, **changed**, or **no trusted reference**. Test the untouched ZIP and copies with an edited report, replaced attachment, or missing attachment. If the user exports a correction, produce a new bundle and digest rather than overwriting the old export as if nothing changed.
   - **Optional signing:** Later, add a detached digital signature over the finished bundle. Keep the private key out of the export and verify offline against a public key the recipient trusts independently of the bundle. A key shipped alongside the export is not by itself a trust source. Label untrusted keys separately from invalid signatures.
   - **What this does not prove:** Files remain editable, and a matching digest or valid signature does not prove who wrote a note, that the review happened, that the report is complete, or whether AI was used. An optional [trusted timestamp](https://www.rfc-editor.org/rfc/rfc3161.html) could establish that the bundle existed by a certain time, not when individual entries were made.

Focus and break controls, [portable backups](https://github.com/ZebrowskiM/Session-Tape/issues/13), and cross-platform packaging remain on the roadmap. They support the workflow without being its main purpose.

## License

Session Tape is available under the [MIT License](LICENSE). Copyright (c) 2026 Marek Zebrowski. See [contributing](CONTRIBUTING.md) for the local workflow.
