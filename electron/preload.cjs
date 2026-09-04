const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multisession', {
  onCommand(cb) {
    const handler = (_e, cmd) => cb(cmd);
    ipcRenderer.on('command', handler);
    return () => ipcRenderer.removeListener('command', handler);
  },
});
