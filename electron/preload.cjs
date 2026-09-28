const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('multisession', {
  onCommand(cb) {
    const handler = (_e, cmd) => cb(cmd);
    ipcRenderer.on('command', handler);
    return () => ipcRenderer.removeListener('command', handler);
  },
  /** Open a link in the user's default browser / app. Returns false if the scheme is refused. */
  openExternal(url) {
    return ipcRenderer.invoke('open-external', String(url));
  },
  /** Absolute path of a dropped File ('' when it has none, e.g. an image dragged out of a web page). */
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
});
