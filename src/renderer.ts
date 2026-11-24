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

async function refresh(): Promise<void> {
  const generation = ++reading;
  try {
    const result = await api.snapshot(panel ? "" : searchField.value);
    if (generation !== reading) return;
    if (!result.ok) { showStatus(result.error, true); return; }
    active = result.value.active;
    startForm.hidden = Boolean(active);
    element("session").hidden = !active;
    element("session-name").textContent = active?.title ?? "";
    controls();
    if (panel) return;
    const list = element("notes");
    const cards = result.value.notes.map(note => {
      const row = document.createElement("li");
      const meta = document.createElement("div");
      meta.className = "note-meta";
      const time = document.createElement("time");
      time.dateTime = note.createdAt;
      time.textContent = new Date(note.createdAt).toLocaleString();
      meta.append(note.sessionTitle + " · ", time);
      const body = document.createElement("p");
      body.className = "note-text";
      body.textContent = note.body;
      row.append(meta, body);
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
