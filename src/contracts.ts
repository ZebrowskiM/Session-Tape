export interface Session {
  id: string;
  title: string;
  startedAt: string;
}

export interface Note {
  id: string;
  sessionId: string;
  sessionTitle: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  versions: NoteVersion[];
}

export interface NoteVersion {
  body: string;
  savedAt: string;
}

export interface Snapshot {
  active: Session | null;
  notes: Note[];
}

export type SessionEventData =
  | { kind: "session.started"; payload: { title: string } }
  | { kind: "session.finished"; payload: Record<string, never> }
  | { kind: "note.added" | "note.edited"; payload: { noteId: string; body: string } };

export type SessionEvent = SessionEventData & {
  id: string;
  sessionId: string;
  sequence: number;
  sequenceSource: "recorded" | "reconstructed";
  occurredAt: string;
  utcOffsetMinutes: number | null;
  // Process monotonic time since session start. Inclusion of system sleep depends on the OS.
  elapsedMs: number | null;
  phase: "focus" | "finished" | null;
  payloadVersion: 1;
};

export interface SessionEventQuery {
  sessionId: string;
  afterSequence?: number;
}

export interface SessionEventPage {
  events: SessionEvent[];
  // Pass this as afterSequence for the next page. Null means this read reached the end.
  nextSequence: number | null;
}

export interface NoteInput {
  id: string;
  sessionId: string;
  body: string;
}

export interface NoteEditInput {
  id: string;
  body: string;
  expectedUpdatedAt: string;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export type View = "archive" | "panel";

export interface SessionTape {
  snapshot(query: string): Promise<Reply<Snapshot>>;
  sessionEvents(query: SessionEventQuery): Promise<Reply<SessionEventPage>>;
  start(title: string): Promise<Reply<void>>;
  finish(sessionId: string): Promise<Reply<void>>;
  addNote(note: NoteInput): Promise<Reply<void>>;
  editNote(note: NoteEditInput): Promise<Reply<void>>;
  show(view: View): Promise<Reply<void>>;
  onChange(listener: () => void): () => void;
}
