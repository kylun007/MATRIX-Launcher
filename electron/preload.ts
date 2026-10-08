import { contextBridge, ipcRenderer } from 'electron';
import type { MatrixBridge, Command, Input, CommandResults, Reply, Snapshot } from '../shared/contracts.ts';
const bridge: MatrixBridge = {
  onSkinClose(listener) { const handler = () => listener(); ipcRenderer.on('matrix:skin-close', handler); return () => ipcRenderer.removeListener('matrix:skin-close', handler); },
  async invoke<C extends Command>(command: C, input?: Input<C>): Promise<CommandResults[C]> {
    const reply: Reply<CommandResults[C]> = await ipcRenderer.invoke('matrix:command', command, input);
    if (!reply.ok) throw new Error(reply.error); return reply.value;
  },
  subscribe(listener) {
    const handler = (_event: unknown, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on('matrix:snapshot', handler); return () => ipcRenderer.removeListener('matrix:snapshot', handler);
  },
};
contextBridge.exposeInMainWorld('matrix', Object.freeze(bridge));
