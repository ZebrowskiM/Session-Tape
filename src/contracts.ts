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
}

export interface Snapshot {
  active: Session | null;
  notes: Note[];
}

export interface NoteInput {
  id: string;
  sessionId: string;
  body: string;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export type View = "archive" | "panel";

export interface SessionTape {
  snapshot(query: string): Promise<Reply<Snapshot>>;
  start(title: string): Promise<Reply<void>>;
  finish(sessionId: string): Promise<Reply<void>>;
  addNote(note: NoteInput): Promise<Reply<void>>;
  show(view: View): Promise<Reply<void>>;
  onChange(listener: () => void): () => void;
}
