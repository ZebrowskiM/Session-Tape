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
const finishButton = element<HTMLButtonElement>("finish");
const clearDraft = element<HTMLButtonElement>("clear-draft");
const notice = element("status");
let active: import("./contracts").Session | null = null;
let draftSession: string | null = null;
let pendingNote: import("./contracts").NoteInput | null = null;
const editDialog = element<HTMLDialogElement>("edit-dialog");
const editForm = element<HTMLFormElement>("edit-form");
const editField = element<HTMLTextAreaElement>("edit-body");
const editSubmit = element<HTMLButtonElement>("submit-edit");
let editBase: ArchiveNote | null = null;
let competingVersion: ArchiveNote | null = null;
let lastRenderedQuery = "";
let editSaving = false;
let reading = 0;
let saving = false;

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

type ArchiveNote = import("./contracts").Note;

function updateEditControls(): void {
  editField.readOnly = editSaving;
  element<HTMLButtonElement>("cancel-edit").disabled = editSaving;
  element<HTMLButtonElement>("review-edit").disabled = editSaving;
  editSubmit.disabled = editSaving || competingVersion !== null || !editField.value.trim();
}

function openEditor(note: ArchiveNote, versionIndex = 0): void {
  const version = note.versions[versionIndex];
  editBase = note;
  competingVersion = null;
  element("edit-conflict").hidden = true;
  element("edit-error").textContent = "";
  element("edit-heading").textContent = versionIndex ? "Restore an earlier version" : "Edit note";
  const date = new Date(version.savedAt).toLocaleString();
  element("edit-context").textContent = versionIndex
    ? `${note.sessionTitle} · Version from ${date}. Saving adds a new edit to the history.`
    : `${note.sessionTitle} · Last saved ${date}`;
  editField.value = version.body;
  updateEditControls();
  editDialog.showModal();
  editField.focus();
  editField.setSelectionRange(editField.value.length, editField.value.length);
}

function checkEditBase(notes: ArchiveNote[]): void {
  if (!editBase) return;
  const latest = notes.find(note => note.id === editBase?.id);
  if (!latest || latest.updatedAt === editBase.updatedAt) return;
  competingVersion = latest;
  element("latest-text").textContent = latest.body;
  element("edit-conflict").hidden = false;
  updateEditControls();
}

function closeEditor(): void {
  const id = editBase?.id;
  editDialog.close();
  editBase = null;
  competingVersion = null;
  const trigger = document.getElementById("edit-" + id);
  (trigger ?? searchField).focus();
}

function displayTime(value: string): HTMLTimeElement {
  const time = document.createElement("time");
  time.dateTime = value;
  time.textContent = new Date(value).toLocaleString();
  return time;
}

function versionHistory(note: ArchiveNote, open?: boolean): HTMLDetailsElement {
  const history = document.createElement("details");
  history.className = "version-history";
  history.dataset.noteId = note.id;
  history.open = open ?? note.versions.some(version => version.matchesSearch);
  const summary = document.createElement("summary");
  summary.textContent = `Version history (${note.versions.length})`;
  const versions = document.createElement("ol");
  note.versions.forEach((version, index) => {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    const number = note.versions.length - index - 1;
    label.textContent = number === 0 ? "Original" : `Edit ${number}${index === 0 ? " (current)" : ""}`;
    item.append(label, " · ", displayTime(version.savedAt));
    if (version.matchesSearch) item.append(" · Search match");
    const body = document.createElement("p");
    body.textContent = version.body;
    item.append(body);
    if (index > 0 && version.body !== note.body) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "quiet";
      restore.textContent = "Restore this version";
      restore.addEventListener("click", () => openEditor(note, index));
      item.append(restore);
    }
    versions.append(item);
  });
  history.append(summary, versions);
  return history;
}

function noteCard(note: ArchiveNote, historyOpen?: boolean): HTMLLIElement {
  const row = document.createElement("li");
  const meta = document.createElement("div");
  meta.className = "note-meta";
  meta.append(note.sessionTitle + " · ", displayTime(note.createdAt));
  if (note.versions.length > 1) meta.append(" · Updated ", displayTime(note.updatedAt));
  const body = document.createElement("p");
  body.className = "note-text";
  body.textContent = note.body;
  const edit = document.createElement("button");
  edit.id = "edit-" + note.id;
  edit.type = "button";
  edit.className = "quiet";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openEditor(note));
  row.append(meta, body, edit);
  if (note.versions.length > 1) row.append(versionHistory(note, historyOpen));
  return row;
}

async function refresh(): Promise<void> {
  const generation = ++reading;
  try {
    const query = panel ? "" : searchField.value.trim();
    const result = await api.snapshot(query);
    if (generation !== reading) return;
    if (!result.ok) { showStatus(result.error, true); return; }
    active = result.value.active;
    startForm.hidden = Boolean(active);
    element("session").hidden = !active;
    element("session-name").textContent = active?.title ?? "";
    controls();
    if (panel) return;
    const list = element("notes");
    checkEditBase(result.value.notes);
    const expanded = new Map<string, boolean>();
    if (query === lastRenderedQuery) {
      list.querySelectorAll<HTMLDetailsElement>("details[data-note-id]").forEach(history => {
        expanded.set(history.dataset.noteId!, history.open);
      });
    }
    lastRenderedQuery = query;
    const cards = result.value.notes.map(note => noteCard(note, expanded.get(note.id)));
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

editField.addEventListener("input", updateEditControls);
element("cancel-edit").addEventListener("click", closeEditor);
editDialog.addEventListener("cancel", event => {
  event.preventDefault();
  if (!editSaving) closeEditor();
});
element("review-edit").addEventListener("click", () => {
  if (!competingVersion) return;
  editBase = competingVersion;
  competingVersion = null;
  element("edit-conflict").hidden = true;
  element("edit-error").textContent = "";
  updateEditControls();
  editField.focus();
});
editForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!editBase || editSubmit.disabled) return;
  editSaving = true;
  updateEditControls();
  element("edit-error").textContent = "";
  try {
    const result = await api.editNote({
      id: editBase.id, body: editField.value, expectedUpdatedAt: editBase.updatedAt,
    });
    if (!result.ok) {
      element("edit-error").textContent = result.error;
      await refresh();
      return;
    }
    showStatus("Note saved.");
    await refresh();
    closeEditor();
  } catch {
    element("edit-error").textContent = "The app could not confirm the save. Try again.";
  } finally {
    editSaving = false;
    updateEditControls();
  }
});
editField.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    if (!editSubmit.disabled) editForm.requestSubmit();
  }
});

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
const unsubscribe = api.onChange(() => void refresh());
window.addEventListener("pagehide", unsubscribe, { once: true });
void refresh();
