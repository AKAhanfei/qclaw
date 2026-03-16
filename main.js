/**
 * QClaw v2.0.1 - 根目录 main.js (fallback entry)
 * 正常情况下 Electron 优先加载 resources/app.asar
 * 此文件作为 app.asar 不可用时的备用入口
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = 3001;
let mainWindow = null;
let serverProcess = null;

function findNodeExe() {
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'nodejs', 'node.exe'),
    ...(process.env.PATH || '').split(';').map(p => path.join(p.trim(), 'node.exe')),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return 'node';
}

function startServer() {
  const serverDir = path.join(process.resourcesPath || __dirname, 'server');
  if (!fs.existsSync(path.join(serverDir, 'index.js'))) {
    console.error('[QClaw] server/index.js not found at', serverDir);
    return;
  }
  const nodeExe = findNodeExe();
  serverProcess = spawn(nodeExe, ['index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  serverProcess.stdout.on('data', d => console.log('[SRV]', d.toString().trim()));
  serverProcess.stderr.on('data', d => console.error('[SRV-ERR]', d.toString().trim()));
  serverProcess.on('exit', code => {
    console.log('[SRV] exited:', code);
    serverProcess = null;
  });
}

async function waitForServer(timeout = 20000) {
  const http = require('http');
  const start = Date.now();
  return new Promise(resolve => {
    const check = () => {
      if (Date.now() - start > timeout) return resolve(false);
      const req = http.get(`http://localhost:${PORT}/health`, res => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        setTimeout(check, 200);
      });
      req.on('error', () => setTimeout(check, 200));
      req.setTimeout(800, () => { req.destroy(); setTimeout(check, 200); });
      req.end();
    };
    check();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#11111b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'resources', 'app.asar', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 优先加载 app.asar 内的 renderer
  const rendererHtml = path.join(__dirname, 'resources', 'app.asar', 'out', 'renderer', 'index.html');
  if (fs.existsSync(rendererHtml)) {
    mainWindow.loadFile(rendererHtml);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }
}

app.whenReady().then(async () => {
  startServer();
  await waitForServer(15000);
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
  if (process.platform !== 'darwin') app.quit();
});
