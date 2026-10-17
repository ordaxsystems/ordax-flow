const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ordax', {
  workspace: () => ipcRenderer.invoke('ordax:workspace:get'),
  listTasks: () => ipcRenderer.invoke('ordax:tasks:list'),
  createTask: title => ipcRenderer.invoke('ordax:tasks:create', title),
  getTask: id => ipcRenderer.invoke('ordax:tasks:get', id),
  openTask: id => ipcRenderer.invoke('ordax:tasks:open', id),
  resumeCapsule: id => ipcRenderer.invoke('ordax:tasks:resume-capsule', id),
  rotateConversation: id => ipcRenderer.invoke('ordax:tasks:rotate-conversation', id),
  send: payload => ipcRenderer.invoke('ordax:tasks:send', payload),
  providerStatus: () => ipcRenderer.invoke('ordax:provider:status'),
  getObserverMode: () => ipcRenderer.invoke('ordax:provider:observer-mode:get'),
  setObserverMode: mode => ipcRenderer.invoke('ordax:provider:observer-mode:set', mode),
  login: () => ipcRenderer.invoke('ordax:provider:login'),
  loginGoogle: () => ipcRenderer.invoke('ordax:provider:login-google'),
  home: () => ipcRenderer.invoke('ordax:provider:home'),
  reload: () => ipcRenderer.invoke('ordax:provider:reload'),
  setChatVisible: visible => ipcRenderer.invoke('ordax:chat:visible', visible),
  onRunStarted: callback => ipcRenderer.on('ordax:task:run-started', (_event, payload) => callback(payload)),
  onTaskStream: callback => ipcRenderer.on('ordax:task:stream', (_event, payload) => callback(payload))
});
