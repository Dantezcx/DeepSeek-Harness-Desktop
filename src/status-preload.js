const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('statusApi', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  openSettings: () => ipcRenderer.invoke('ui:settings'),
  quit: () => ipcRenderer.invoke('ui:quit'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  doUpdate: () => ipcRenderer.invoke('update:do'),
});
