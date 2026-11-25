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

## Next milestones

The goal is a reviewable record of human judgment, not an AI detector. Start with one end-to-end workflow: record a suggestion, the evidence you checked, and your decision; revisit it later; add a correction without rewriting the original; and share a report someone can read without the app.

1. **Capture the decision as you work.** Build on the existing notes with an [ordered session log](https://github.com/ZebrowskiM/Session-Tape/issues/1) and [draft recovery](https://github.com/ZebrowskiM/Session-Tape/issues/5). Start with optional prompts for what AI suggested, what you checked, and what you accepted, changed, or rejected and why. Keep capture manual; a draft is not a recorded decision. Mark uncertain time after [sleep or clock changes](https://github.com/ZebrowskiM/Session-Tape/issues/3) rather than inventing activity.
2. **Revisit and correct without erasing the record.** Start with a chronological view of saved notes and [linked corrections](https://github.com/ZebrowskiM/Session-Tape/issues/10). Preserve the original across restarts and give each correction its own date. Test the text workflow against the fictional CSV example and extend it to [manual snips](https://github.com/ZebrowskiM/Session-Tape/issues/6) and [note history](https://github.com/ZebrowskiM/Session-Tape/issues/8). Keep full keyboard-accessible [timeline replay](https://github.com/ZebrowskiM/Session-Tape/issues/9) and richer [search](https://github.com/ZebrowskiM/Session-Tape/issues/7) on the roadmap without making them prerequisites for the first readable report.
3. **Share only what the reader needs.** Start with an offline [Markdown report](https://github.com/ZebrowskiM/Session-Tape/issues/11), then [PDF](https://github.com/ZebrowskiM/Session-Tape/issues/12) from the same report model. Preview the contents, allow sensitive notes or attachments to be omitted, and label partial exports. Keep unsaved drafts and local file paths out; verify that correction links still work after moving the bundle. Use the [next-day handoff pilot](https://github.com/ZebrowskiM/Session-Tape/issues/25) to check that someone with only the report can explain the decision, its rationale, and the later correction.
4. **Check the exported bytes, not the author.** Under [local data controls and provenance](https://github.com/ZebrowskiM/Session-Tape/issues/15), plan a detached SHA-256 digest for the finished report bundle. Verify that the original matches an independently retained digest and that a deliberately edited copy fails verification. An optional [trusted timestamp](https://www.rfc-editor.org/rfc/rfc3161.html) is a later enhancement; it could establish that the export existed by a certain time, not when each entry was made. Neither a digest nor a timestamp proves identity, completeness, that a review happened, or whether AI was used.

Focus and break controls, [portable backups](https://github.com/ZebrowskiM/Session-Tape/issues/13), and cross-platform packaging remain on the roadmap. They support the workflow without being its main purpose.

## License

Session Tape is available under the [MIT License](LICENSE). Copyright (c) 2026 Marek Zebrowski. See [contributing](CONTRIBUTING.md) for the local workflow.
