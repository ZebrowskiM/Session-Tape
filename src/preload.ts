import { contextBridge, ipcRenderer } from "electron";
import type { SessionTape } from "./contracts";

const bridge: SessionTape = {
  snapshot: query => ipcRenderer.invoke("archive:snapshot", query),
  sessionEvents: query => ipcRenderer.invoke("session:events", query),
  start: title => ipcRenderer.invoke("session:start", title),
  changePhase: input => ipcRenderer.invoke("session:phase", input),
  finish: id => ipcRenderer.invoke("session:finish", id),
  addNote: note => ipcRenderer.invoke("note:add", note),
  editNote: note => ipcRenderer.invoke("note:edit", note),
  show: view => ipcRenderer.invoke("window:show", view),
  onChange: listener => {
    const notify = () => listener();
    ipcRenderer.on("archive:changed", notify);
    return () => ipcRenderer.removeListener("archive:changed", notify);
  },
};

contextBridge.exposeInMainWorld("sessionTape", bridge);
