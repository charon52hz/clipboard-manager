/**
 * Tauri 版 clipboardAPI —— 使用 @tauri-apps/api 包
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

let _listener = null

window.clipboardAPI = {
  getHistory: (limit) => invoke('get_history', { limit: limit || 100 }),
  copyItem: (item) => invoke('copy_item', { item }),
  deleteItem: (id) => invoke('delete_item', { id }),
  togglePin: (id) => invoke('toggle_pin', { id }),
  clearHistory: () => invoke('clear_history'),
  getImageData: (imagePath) => invoke('get_image_data', { imagePath }),
  quitApp: () => invoke('quit_app'),

  onChanged: (callback) => {
    _listener = listen('clipboard-changed', callback)
  },
  removeChangedListener: () => {
    if (_listener) {
      _listener.then((unlisten) => unlisten())
      _listener = null
    }
  },
}
