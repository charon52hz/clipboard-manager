const { app, BrowserWindow, Tray, clipboard, nativeImage, ipcMain, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const initSqlJs = require('sql.js')

// ======================== Globals ========================
let tray = null
let mainWindow = null
let db = null
let dbPath = ''
let clipboardMonitor = null
let lastClipboardText = ''
let lastClipboardImageSize = 0
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

/** 将 sql.js 查询结果转为对象数组（类似 better-sqlite3 的 .all()） */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql)
  if (params.length > 0) stmt.bind(params)
  const results = []
  while (stmt.step()) {
    results.push(stmt.getAsObject())
  }
  stmt.free()
  return results
}

/** 查询单条记录 */
function queryOne(sql, params = []) {
  const results = queryAll(sql, params)
  return results.length > 0 ? results[0] : null
}

/** 执行写操作并自动保存到磁盘 */
function execute(sql, params = []) {
  db.run(sql, params)
  saveDatabase()
}

/** 将内存中的数据库数据写入磁盘文件 */
function saveDatabase() {
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (e) {
    console.error('Failed to save database:', e)
  }
}

/** 初始化数据库（异步） */
async function initDatabase() {
  const SQL = await initSqlJs()
  dbPath = path.join(app.getPath('userData'), 'clipboard.db')

  // 如果已有数据库文件则加载，否则创建新的
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  db.run('PRAGMA journal_mode = WAL')

  db.run(`
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

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_created_at
    ON clipboard_history(created_at DESC)
  `)

  saveDatabase()
}

function addToHistory(type, content, imagePath, preview) {
  execute(
    'INSERT INTO clipboard_history (type, content, image_path, preview) VALUES (?, ?, ?, ?)',
    [type, content, imagePath, preview]
  )

  // 保留最近 500 条记录
  const row = queryOne('SELECT COUNT(*) as count FROM clipboard_history')
  if (row && row.count > 500) {
    execute(
      'DELETE FROM clipboard_history WHERE id NOT IN (SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT 500)'
    )
  }
}

function getHistory(limit = 100) {
  return queryAll(
    'SELECT * FROM clipboard_history ORDER BY pinned DESC, created_at DESC LIMIT ?',
    [limit]
  )
}

function deleteItem(id) {
  const item = queryOne('SELECT * FROM clipboard_history WHERE id = ?', [id])
  if (item && item.image_path) {
    try { fs.unlinkSync(item.image_path) } catch (e) { /* ignore */ }
  }
  execute('DELETE FROM clipboard_history WHERE id = ?', [id])
}

function clearHistory() {
  const items = queryAll('SELECT image_path FROM clipboard_history WHERE image_path IS NOT NULL')
  for (const item of items) {
    try { fs.unlinkSync(item.image_path) } catch (e) { /* ignore */ }
  }
  execute('DELETE FROM clipboard_history')
}

function togglePin(id) {
  const item = queryOne('SELECT pinned FROM clipboard_history WHERE id = ?', [id])
  if (item) {
    execute('UPDATE clipboard_history SET pinned = ? WHERE id = ?', [item.pinned ? 0 : 1, id])
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
        const latest = queryOne('SELECT * FROM clipboard_history ORDER BY created_at DESC LIMIT 1')
        if (latest && latest.type === 'text' && latest.content === currentText) return

        const preview = currentText.substring(0, 200)
        addToHistory('text', currentText, null, preview)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('clipboard-changed')
        }
      }

      // 检查图片
      const image = clipboard.readImage()
      if (!image.isEmpty()) {
        const imgBuffer = image.toPNG()

        // 通过图片大小去重：同一张图片在剪贴板中大小不变
        if (imgBuffer.length === lastClipboardImageSize) return
        lastClipboardImageSize = imgBuffer.length

        const imgFilename = `clip_${Date.now()}.png`
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
  const iconPath = path.join(app.getPath('userData'), 'tray-icon.png')

  // 如果图标文件不存在，则生成一个
  if (!fs.existsSync(iconPath)) {
    const { createClipboardIconPNG } = require('./generate-icon')
    fs.writeFileSync(iconPath, createClipboardIconPNG())
  }

  const icon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }
  return icon
}

function createTray() {
  const icon = createTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('剪贴板管理器')

  tray.on('click', () => toggleWindow())
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
    // 等待视觉反馈显示后再隐藏窗口
    await new Promise(resolve => setTimeout(resolve, 500))
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

  ipcMain.handle('quit-app', async () => {
    app.quit()
  })
}

// ======================== App Lifecycle ========================
app.whenReady().then(async () => {
  // 初始化图片存储目录
  imageDir = path.join(app.getPath('userData'), 'clipboard_images')
  if (!fs.existsSync(imageDir)) {
    fs.mkdirSync(imageDir, { recursive: true })
  }

  await initDatabase()
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
  if (db) {
    saveDatabase()
    db.close()
  }
})

app.on('window-all-closed', (e) => {
  // 托盘应用不应在关闭窗口时退出
  e.preventDefault()
})
