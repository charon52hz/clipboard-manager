const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clipboardAPI', {
  /** 获取剪贴板历史记录 */
  getHistory: (limit) => ipcRenderer.invoke('get-history', limit),

  /** 将指定项复制到剪贴板 */
  copyItem: (item) => ipcRenderer.invoke('copy-item', item),

  /** 删除指定项 */
  deleteItem: (id) => ipcRenderer.invoke('delete-item', id),

  /** 切换置顶状态 */
  togglePin: (id) => ipcRenderer.invoke('toggle-pin', id),

  /** 清空全部历史 */
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  /** 获取图片的 base64 数据 */
  getImageData: (imagePath) => ipcRenderer.invoke('get-image-data', imagePath),

  /** 监听剪贴板变化事件 */
  onChanged: (callback) => {
    ipcRenderer.on('clipboard-changed', callback)
  },

  /** 移除剪贴板变化监听 */
  removeChangedListener: (callback) => {
    ipcRenderer.removeListener('clipboard-changed', callback)
  },

  /** 退出应用 */
  quitApp: () => ipcRenderer.invoke('quit-app')
})
