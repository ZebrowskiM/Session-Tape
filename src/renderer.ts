function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
}

const api = window.sessionTape;
const panel = new URLSearchParams(location.search).get("view") === "panel";
const startForm = element<HTMLFormElement>("start-form");
const noteForm = element<HTMLFormElement>("note-form");
const titleField = element<HTMLInputElement>("title");
const bodyField = element<HTMLTextAreaElement>("note");
const searchField = element<HTMLInputElement>("search");
const saveButton = element<HTMLButtonElement>("save-note");
const phaseButton = element<HTMLButtonElement>("change-phase");
const breakForm = element<HTMLFormElement>("break-form");
const breakLength = element<HTMLSelectElement>("break-length");
const customMinutes = element<HTMLInputElement>("break-minutes");
const countdown = element("countdown");
const finishButton = element<HTMLButtonElement>("finish");
const clearDraft = element<HTMLButtonElement>("clear-draft");
const notice = element("status");
let active: import("./contracts").Session | null = null;
let draftSession: string | null = null;
let pendingNote: import("./contracts").NoteInput | null = null;
let editingNoteId: string | null = null;
let editDraft = "";
let editSaving = false;
let reading = 0;
let saving = false;
let notesPending = true;
let countdownInterval: number | undefined;

document.body.classList.toggle("panel", panel);
element("heading").textContent = panel ? "Quick note" : "Session archive";
element("switch").textContent = panel ? "Open archive" : "Open panel";
element("archive").hidden = panel;
finishButton.hidden = panel;
element("shortcut").textContent = /mac/i.test(navigator.platform) ? "⌘ + Enter" : "Ctrl + Enter";

function showStatus(message: string, error = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function controls(): void {
  const orphan = Boolean(bodyField.value && draftSession && draftSession !== active?.id);
  noteForm.hidden = !active && !orphan;
  saveButton.disabled = saving || !active || orphan;
  clearDraft.hidden = !orphan;
  if (orphan) showStatus("The original session is closed. Copy this draft or clear it to continue.", true);
}

function showCountdown(remaining: number | null): void {
  window.clearInterval(countdownInterval);
  countdown.hidden = remaining === null;
  if (remaining === null) return;
  const deadline = performance.now() + remaining;
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    countdown.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  tick();
  countdownInterval = window.setInterval(tick, 250);
}

async function refresh(phaseOnly = false): Promise<void> {
  if (!phaseOnly) notesPending = true;
  const generation = ++reading;
  try {
    const result = await api.snapshot(panel ? "" : searchField.value);
    if (generation !== reading) return;
    if (!result.ok) { showStatus(result.error, true); return; }
    const previous = active;
    active = result.value.active;
    if (previous?.phase === "break" && previous.id === active?.id && active.phase === "focus") {
      showStatus("Focus resumed.");
    }
    startForm.hidden = Boolean(active);
    element("session").hidden = !active;
    element("session-name").textContent = active?.title ?? "";
    showCountdown(result.value.breakRemainingMs);
    breakForm.hidden = active?.phase !== "focus";
    if (active) {
      const labels = { focus: "Focus", paused: "Paused", break: "Break" };
      element("phase-name").textContent = active.phase ? labels[active.phase] : "Phase unknown";
      phaseButton.textContent = active.phase === "break" ? "End early" : active.phase === "focus" ? "Pause" : "Resume focus";
    }
    controls();
    if (panel || !notesPending) return;
    notesPending = false;
    const list = element("notes");
    const cards = result.value.notes.map(note => {
      const row = document.createElement("li");
      const meta = document.createElement("div");
      meta.className = "note-meta";
      const time = document.createElement("time");
      time.dateTime = note.createdAt;
      time.textContent = new Date(note.createdAt).toLocaleString();
      meta.append(note.sessionTitle + " · ", time);
      if (note.updatedAt !== note.createdAt) {
        const updated = document.createElement("time");
        updated.dateTime = note.updatedAt;
        updated.textContent = ` · Updated ${new Date(note.updatedAt).toLocaleString()}`;
        meta.append(updated);
      }
      row.append(meta);
      if (editingNoteId === note.id) {
        const editor = document.createElement("textarea");
        editor.className = "note-edit";
        editor.maxLength = 16000;
        editor.rows = 4;
        editor.value = editDraft;
        editor.addEventListener("input", () => { editDraft = editor.value; });
        const actions = document.createElement("div");
        actions.className = "edit-actions";
        const save = document.createElement("button");
        save.type = "button";
        save.textContent = "Save edit";
        save.disabled = editSaving;
        save.addEventListener("click", async () => {
          if (editSaving || !editDraft.trim()) {
            showStatus("Enter a note first.", true);
            return;
          }
          editSaving = true;
          save.disabled = true;
          const ok = await apply(api.editNote({
            id: note.id,
            body: editDraft,
            expectedUpdatedAt: note.updatedAt,
          }));
          editSaving = false;
          if (!ok) { save.disabled = false; return; }
          editingNoteId = null;
          editDraft = "";
          showStatus("Note updated.");
          await refresh();
        });
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "quiet";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => {
          editingNoteId = null;
          editDraft = "";
          void refresh();
        });
        actions.append(save, cancel);
        row.append(editor, actions);
      } else {
        const body = document.createElement("p");
        body.className = "note-text";
        body.textContent = note.body;
        const actions = document.createElement("div");
        actions.className = "note-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "quiet";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => {
          editingNoteId = note.id;
          editDraft = note.body;
          void refresh();
        });
        actions.append(edit);
        if (note.versions.length > 1) {
          const history = document.createElement("details");
          history.className = "version-history";
          const summary = document.createElement("summary");
          summary.textContent = `Version history (${note.versions.length})`;
          const versions = document.createElement("ol");
          for (const version of note.versions) {
            const item = document.createElement("li");
            const savedAt = document.createElement("time");
            savedAt.dateTime = version.savedAt;
            savedAt.textContent = new Date(version.savedAt).toLocaleString();
            const versionBody = document.createElement("p");
            versionBody.textContent = version.body;
            item.append(savedAt, versionBody);
            versions.append(item);
          }
          history.append(summary, versions);
          actions.append(history);
        }
        row.append(body, actions);
      }
      return row;
    });
    list.replaceChildren(...cards);
    const empty = element("empty");
    empty.hidden = cards.length !== 0;
    empty.textContent = searchField.value.trim() ? "No matching notes." : "Saved notes will appear here.";
  } catch {
    if (generation === reading) showStatus("Could not load the archive. Reopen the window to retry.", true);
  }
}

async function apply(action: Promise<import("./contracts").Reply<void>>): Promise<boolean> {
  try {
    const result = await action;
    if (!result.ok) { showStatus(result.error, true); return false; }
    return true;
  } catch {
    showStatus("The app could not confirm the change. Try again.", true);
    return false;
  }
}

startForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = startForm.querySelector("button")!;
  button.disabled = true;
  if (await apply(api.start(titleField.value))) {
    titleField.value = "";
    showStatus("Session started.");
    await refresh();
    bodyField.focus();
  }
  button.disabled = false;
});

phaseButton.addEventListener("click", async () => {
  if (!active || phaseButton.disabled) return;
  phaseButton.disabled = true;
  const phase = active.phase === "focus" ? "paused" : "focus";
  if (await apply(api.changePhase({ sessionId: active.id, phase, expectedSequence: active.phaseSequence }))) {
    showStatus(phase === "paused" ? "Session paused." : "Focus resumed.");
  }
  await refresh(true);
  phaseButton.disabled = false;
});

breakLength.addEventListener("change", () => {
  const custom = breakLength.value === "custom";
  customMinutes.hidden = customMinutes.disabled = !custom;
  customMinutes.required = custom;
});

breakForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (active?.phase !== "focus") return;
  const button = element<HTMLButtonElement>("start-break");
  if (button.disabled) return;
  button.disabled = true;
  const minutes = breakLength.value === "custom" ? customMinutes.valueAsNumber : Number(breakLength.value);
  if (await apply(api.startBreak({ sessionId: active.id, expectedSequence: active.phaseSequence, minutes }))) {
    showStatus("Break started.");
  }
  await refresh(true);
  button.disabled = false;
});

finishButton.addEventListener("click", async () => {
  if (!active) return;
  if (bodyField.value.trim()) { showStatus("Save or clear your draft before finishing this session.", true); return; }
  finishButton.disabled = true;
  if (await apply(api.finish(active.id))) { showStatus("Session finished."); await refresh(); }
  finishButton.disabled = false;
});

bodyField.addEventListener("input", () => {
  if (!bodyField.value) draftSession = null;
  else if (!draftSession) draftSession = active?.id ?? null;
  pendingNote = null;
  controls();
});
clearDraft.addEventListener("click", () => {
  bodyField.value = "";
  draftSession = null;
  pendingNote = null;
  showStatus("");
  controls();
});
noteForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (saving || !active || (draftSession && draftSession !== active.id)) return;
  if (!bodyField.value.trim()) { showStatus("Enter a note first.", true); return; }
  pendingNote ??= { id: crypto.randomUUID(), sessionId: active.id, body: bodyField.value };
  saving = true;
  bodyField.readOnly = true;
  controls();
  if (await apply(api.addNote(pendingNote))) {
    bodyField.value = "";
    draftSession = null;
    pendingNote = null;
    showStatus("Note saved.");
    await refresh();
  }
  bodyField.readOnly = false;
  saving = false;
  controls();
  if (!noteForm.hidden) bodyField.focus();
});

bodyField.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    if (!saveButton.disabled) noteForm.requestSubmit();
  }
});
element("switch").addEventListener("click", () => { void apply(api.show(panel ? "archive" : "panel")); });
searchField.addEventListener("input", () => void refresh());
const unsubscribe = api.onChange(phaseOnly => void refresh(phaseOnly));
window.addEventListener("pagehide", unsubscribe, { once: true });
void refresh();
