const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');

if (!app.isPackaged) {
  require('electron-reload')(__dirname, {
    electron: path.join(__dirname, 'node_modules', '.bin', 'electron.cmd'),
    forceHardReset: true,
    hardResetMethod: 'exit',
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#1e2a37',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    }
  });

  Menu.setApplicationMenu(null);

  let startUrl;
  if (process.env.ELECTRON_START_URL) {
    startUrl = process.env.ELECTRON_START_URL;
  } else {
    const indexPath = app.isPackaged
      ? path.join(process.resourcesPath, 'frontend', 'browser', 'index.html')
      : path.join(__dirname, 'frontend', 'browser', 'index.html');
    startUrl = `file://${indexPath}`;
  }

  win.loadURL(startUrl);

  ipcMain.handle('win:minimize', () => win.minimize());
  ipcMain.handle('win:toggle-maximize', () => {
    if (win.isMaximized()) { win.unmaximize(); return false; }
    win.maximize();
    return true;
  });
  ipcMain.handle('win:close', () => win.close());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
