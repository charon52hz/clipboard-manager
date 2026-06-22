<template>
  <div class="app">
    <header class="app-header">
      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16">
          <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2"/>
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索剪贴板历史..."
          class="search-input"
          @input="onSearch"
        />
        <button v-if="searchQuery" class="clear-search" @click="searchQuery = ''; loadHistory()">
          ×
        </button>
      </div>
      <div class="header-actions">
        <span class="item-count">{{ items.length }} 条记录</span>
        <div class="header-btns">
          <button class="btn-icon" title="清空历史" @click="handleClear">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <polyline points="3,6 5,6 21,6" fill="none" stroke="currentColor" stroke-width="2"/>
              <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6M8,6V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6"
                    fill="none" stroke="currentColor" stroke-width="2"/>
            </svg>
          </button>
          <button class="btn-icon quit-btn" title="退出应用" @click="handleQuit">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <line x1="12" y1="2" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </header>

    <div class="history-list" v-if="items.length > 0">
      <ClipboardItem
        v-for="item in items"
        :key="item.id"
        :item="item"
        @copy="handleCopy"
        @delete="handleDelete"
        @pin="handlePin"
      />
    </div>

    <div class="empty-state" v-else>
      <svg viewBox="0 0 24 24" width="48" height="48" class="empty-icon">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"
              fill="none" stroke="currentColor" stroke-width="1.5"/>
        <rect x="8" y="2" width="8" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <p>{{ searchQuery ? '没有匹配的记录' : '暂无剪贴板记录' }}</p>
      <p class="hint">复制文字或图片后自动记录</p>
    </div>

    <footer class="app-footer">
      <span class="shortcut-hint">
        {{ isMac ? '⌘' : 'Ctrl' }}+Shift+V 唤出
      </span>
    </footer>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue'
import ClipboardItem from './components/ClipboardItem.vue'

export default {
  name: 'App',
  components: { ClipboardItem },
  setup() {
    const items = ref([])
    const searchQuery = ref('')
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
    let changeHandler = null

    async function loadHistory() {
      try {
        if (searchQuery.value.trim()) {
          // 前端过滤（MVP 简单实现）
          const all = await window.clipboardAPI.getHistory(200)
          const q = searchQuery.value.toLowerCase()
          items.value = all.filter(item =>
            (item.type === 'text' && item.content && item.content.toLowerCase().includes(q)) ||
            (item.preview && item.preview.toLowerCase().includes(q))
          )
        } else {
          items.value = await window.clipboardAPI.getHistory(100)
        }
      } catch (e) {
        console.error('Failed to load history:', e)
      }
    }

    function onSearch() {
      loadHistory()
    }

    async function handleCopy(item) {
      await window.clipboardAPI.copyItem(item)
    }

    async function handleDelete(item) {
      await window.clipboardAPI.deleteItem(item.id)
      loadHistory()
    }

    async function handlePin(item) {
      await window.clipboardAPI.togglePin(item.id)
      loadHistory()
    }

    async function handleClear() {
      if (confirm('确定要清空所有剪贴板历史记录吗？')) {
        await window.clipboardAPI.clearHistory()
        loadHistory()
      }
    }

    function handleQuit() {
      window.clipboardAPI.quitApp()
    }

    onMounted(() => {
      loadHistory()
      changeHandler = () => loadHistory()
      window.clipboardAPI.onChanged(changeHandler)
    })

    onUnmounted(() => {
      if (changeHandler) {
        window.clipboardAPI.removeChangedListener(changeHandler)
      }
    })

    return {
      items,
      searchQuery,
      isMac,
      onSearch,
      loadHistory,
      handleCopy,
      handleDelete,
      handlePin,
      handleClear,
      handleQuit
    }
  }
}
</script>
