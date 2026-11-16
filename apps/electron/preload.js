const { contextBridge, ipcRenderer } = require('electron');

const api = {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
  close: () => ipcRenderer.invoke('win:close'),
  onMaxChange: (cb) => ipcRenderer.on('win:maximized-changed', (_e, is) => cb(!!is)),
};

contextBridge.exposeInMainWorld('electronAPI', api);
contextBridge.exposeInMainWorld('electronWindow', api);
