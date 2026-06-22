const { app, BrowserWindow, Tray, Menu, clipboard, nativeImage, ipcMain, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

// ======================== Globals ========================
let tray = null
let mainWindow = null
let db = null
let clipboardMonitor = null
let lastClipboardText = ''
let imageDir = ''

// ======================== App Paths ========================
function getPreloadPath() {
  return path.join(__dirname, '..', 'preload', 'index.js')
}

function getRendererURL() {
  return 'http://localhost:5173'
}

function getRendererFile() {
  return path.join(__dirname, '..', '..', 'dist', 'index.html')
}

function isDev() {
  return !app.isPackaged
}

// ======================== Database ========================
function initDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'clipboard.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS clipboard_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT,
      image_path TEXT,
      preview TEXT,
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
      pinned INTEGER DEFAULT 0
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_created_at
    ON clipboard_history(created_at DESC)
  `)
}

function addToHistory(type, content, imagePath, preview) {
  const stmt = db.prepare(
    'INSERT INTO clipboard_history (type, content, image_path, preview) VALUES (?, ?, ?, ?)'
  )
  const result = stmt.run(type, content, imagePath, preview)

  // 保留最近 500 条记录
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM clipboard_history')
  const { count } = countStmt.get()
  if (count > 500) {
    db.prepare(
      'DELETE FROM clipboard_history WHERE id NOT IN (SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT 500)'
    ).run()
  }

  return result.lastInsertRowid
}

function getHistory(limit = 100) {
  return db.prepare(
    'SELECT * FROM clipboard_history ORDER BY pinned DESC, created_at DESC LIMIT ?'
  ).all(limit)
}

function deleteItem(id) {
  const item = db.prepare('SELECT * FROM clipboard_history WHERE id = ?').get(id)
  if (item && item.image_path) {
    try { fs.unlinkSync(item.image_path) } catch (e) { /* ignore */ }
  }
  return db.prepare('DELETE FROM clipboard_history WHERE id = ?').run(id)
}

function clearHistory() {
  const items = db.prepare('SELECT image_path FROM clipboard_history WHERE image_path IS NOT NULL').all()
  for (const item of items) {
    try { fs.unlinkSync(item.image_path) } catch (e) { /* ignore */ }
  }
  return db.prepare('DELETE FROM clipboard_history').run()
}

function togglePin(id) {
  const item = db.prepare('SELECT pinned FROM clipboard_history WHERE id = ?').get(id)
  if (item) {
    db.prepare('UPDATE clipboard_history SET pinned = ? WHERE id = ?').run(item.pinned ? 0 : 1, id)
  }
}

// ======================== Clipboard Monitor ========================
function startClipboardMonitor() {
  clipboardMonitor = setInterval(() => {
    try {
      // 检查文本变化
      const currentText = clipboard.readText()
      if (currentText && currentText !== lastClipboardText && currentText.trim().length > 0) {
        lastClipboardText = currentText

        // 去重：如果最近一条内容相同则跳过
        const latest = db.prepare('SELECT * FROM clipboard_history ORDER BY created_at DESC LIMIT 1').get()
        if (latest && latest.type === 'text' && latest.content === currentText) return

        const preview = currentText.substring(0, 200)
        addToHistory('text', currentText, null, preview)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-changed')
        }
      }

      // 检查图片（仅在文本无变化时检查，避免重复）
      const image = clipboard.readImage()
      if (!image.isEmpty()) {
        const imgBuffer = image.toPNG()
        const imgHash = `${imgBuffer.length}_${Date.now()}`

        // 简单去重
        const latestImg = db.prepare(
          'SELECT * FROM clipboard_history WHERE type = "image" ORDER BY created_at DESC LIMIT 1'
        ).get()
        if (latestImg && Date.now() - new Date(latestImg.created_at).getTime() < 2000) return

        const imgFilename = `clip_${Date.now()}_${imgHash.substring(0, 16)}.png`
        const imgPath = path.join(imageDir, imgFilename)
        fs.writeFileSync(imgPath, imgBuffer)

        addToHistory('image', null, imgPath, `[图片 ${Math.round(imgBuffer.length / 1024)}KB]`)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-changed')
        }
      }
    } catch (e) {
      // 静默处理剪贴板读取异常
    }
  }, 800)
}

// ======================== Tray ========================
function createTrayIcon() {
  // 创建一个简单的 SVG 图标并转为 PNG
  const svgIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
         fill="none" stroke="#666666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
      <line x1="9" y1="12" x2="15" y2="12"/>
      <line x1="9" y1="16" x2="15" y2="16"/>
    </svg>
  `
  const icon = nativeImage.createFromBuffer(Buffer.from(svgIcon))
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }
  return icon
}

function createTray() {
  const icon = createTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('剪贴板管理器')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开剪贴板历史',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: '清空历史',
      click: () => {
        clearHistory()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-changed')
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)

  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => tray.popUpContextMenu())
}

// ======================== Window ========================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 点击窗口外部区域时隐藏
  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
  })

  // 加载页面
  if (isDev()) {
    mainWindow.loadURL(getRendererURL())
  } else {
    mainWindow.loadFile(getRendererFile())
  }
}

function toggleWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    showWindowNearTray()
  }
}

function showWindowNearTray() {
  if (!mainWindow || !tray) return

  const trayBounds = tray.getBounds()
  const windowBounds = mainWindow.getBounds()
  const display = require('electron').screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y
  })
  const screenBounds = display.workArea

  let x, y

  if (process.platform === 'darwin') {
    // macOS：显示在托盘图标下方
    x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2)
    y = Math.round(trayBounds.y + trayBounds.height + 4)
  } else {
    // Windows：显示在托盘图标上方
    x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2)
    y = Math.round(trayBounds.y - windowBounds.height - 8)
  }

  // 确保窗口不超出屏幕
  x = Math.max(screenBounds.x, Math.min(x, screenBounds.x + screenBounds.width - windowBounds.width))
  y = Math.max(screenBounds.y, Math.min(y, screenBounds.y + screenBounds.height - windowBounds.height))

  mainWindow.setPosition(x, y)
  mainWindow.show()
  mainWindow.focus()
}

// ======================== IPC Handlers ========================
function setupIPC() {
  ipcMain.handle('get-history', async (_event, limit) => {
    return getHistory(limit || 100)
  })

  ipcMain.handle('delete-item', async (_event, id) => {
    deleteItem(id)
    return { success: true }
  })

  ipcMain.handle('toggle-pin', async (_event, id) => {
    togglePin(id)
    return { success: true }
  })

  ipcMain.handle('clear-history', async () => {
    clearHistory()
    return { success: true }
  })

  ipcMain.handle('copy-item', async (_event, item) => {
    if (item.type === 'text') {
      clipboard.writeText(item.content)
      lastClipboardText = item.content
    } else if (item.type === 'image' && item.image_path) {
      try {
        const img = nativeImage.createFromPath(item.image_path)
        if (!img.isEmpty()) {
          clipboard.writeImage(img)
        }
      } catch (e) {
        console.error('Failed to copy image:', e)
      }
    }
    // 复制到剪贴板后隐藏窗口
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide()
    }
    return { success: true }
  })

  ipcMain.handle('get-image-data', async (_event, imagePath) => {
    try {
      const buffer = fs.readFileSync(imagePath)
      return `data:image/png;base64,${buffer.toString('base64')}`
    } catch (e) {
      return null
    }
  })
}

// ======================== App Lifecycle ========================
app.whenReady().then(() => {
  // 初始化图片存储目录
  imageDir = path.join(app.getPath('userData'), 'clipboard_images')
  if (!fs.existsSync(imageDir)) {
    fs.mkdirSync(imageDir, { recursive: true })
  }

  initDatabase()
  setupIPC()
  createWindow()
  createTray()
  startClipboardMonitor()

  // 注册全局快捷键 Ctrl+Shift+V / Cmd+Shift+V
  const shortcutKey = process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V'
  globalShortcut.register(shortcutKey, () => {
    showWindowNearTray()
  })
})

app.on('will-quit', () => {
  if (clipboardMonitor) clearInterval(clipboardMonitor)
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', (e) => {
  // 托盘应用不应在关闭窗口时退出
  e.preventDefault()
})
