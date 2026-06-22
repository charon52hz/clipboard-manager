<template>
  <div
    class="clipboard-item"
    :class="{ pinned: item.pinned, copied: justCopied }"
    @click="handleCopy"
    :title="item.type === 'text' ? '点击复制到剪贴板' : '点击图片复制到剪贴板'"
  >
    <div class="item-indicator">
      <span class="type-badge" :class="item.type">
        {{ justCopied ? '✓' : (item.type === 'text' ? '文' : '图') }}
      </span>
      <span v-if="item.pinned" class="pin-badge">📌</span>
    </div>

    <div class="item-content">
      <!-- 文本类型 -->
      <div v-if="item.type === 'text'" class="text-preview">
        <p class="text-body">{{ displayText }}</p>
      </div>

      <!-- 图片类型 -->
      <div v-else class="image-preview">
        <img v-if="imageSrc" :src="imageSrc" alt="剪贴板图片" />
        <div v-else class="image-loading">加载中...</div>
      </div>

      <div class="item-meta">
        <span class="timestamp">{{ formatTime(item.created_at) }}</span>
        <span v-if="item.type === 'text'" class="char-count">
          {{ (item.content || '').length }} 字符
        </span>
        <span v-if="justCopied" class="copied-hint">已复制</span>
      </div>
    </div>

    <div class="item-actions" @click.stop>
      <button class="action-btn pin-btn" :title="item.pinned ? '取消置顶' : '置顶'" @click="$emit('pin', item)">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path d="M12 2L12 12M12 12L8 8M12 12L16 8M5 18H19"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
      <button class="action-btn delete-btn" title="删除" @click="$emit('delete', item)">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2"/>
          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, computed } from 'vue'

export default {
  name: 'ClipboardItem',
  props: {
    item: { type: Object, required: true }
  },
  emits: ['copy', 'delete', 'pin'],
  setup(props, { emit }) {
    const imageSrc = ref(null)
    const justCopied = ref(false)

    const displayText = computed(() => {
      const text = props.item.content || ''
      return text.length > 150 ? text.substring(0, 150) + '...' : text
    })

    async function loadImage() {
      if (props.item.type === 'image' && props.item.image_path) {
        imageSrc.value = await window.clipboardAPI.getImageData(props.item.image_path)
      }
    }

    async function handleCopy() {
      const plainItem = JSON.parse(JSON.stringify(props.item))

      // 立即显示视觉反馈
      justCopied.value = true

      try {
        await window.clipboardAPI.copyItem(plainItem)
      } catch (e) {
        // 复制失败时取消视觉反馈
        justCopied.value = false
        return
      }

      // 500ms 后取消高亮（与窗口隐藏时间同步）
      setTimeout(() => {
        justCopied.value = false
      }, 500)
    }

    function formatTime(dateStr) {
      if (!dateStr) return ''
      const date = new Date(dateStr)
      const now = new Date()
      const diffMs = now - date
      const diffMins = Math.floor(diffMs / 60000)
      const diffHours = Math.floor(diffMs / 3600000)

      if (diffMins < 1) return '刚刚'
      if (diffMins < 60) return `${diffMins} 分钟前`
      if (diffHours < 24) return `${diffHours} 小时前`

      const month = (date.getMonth() + 1).toString().padStart(2, '0')
      const day = date.getDate().toString().padStart(2, '0')
      const hour = date.getHours().toString().padStart(2, '0')
      const min = date.getMinutes().toString().padStart(2, '0')
      return `${month}-${day} ${hour}:${min}`
    }

    onMounted(() => {
      loadImage()
    })

    return { imageSrc, displayText, justCopied, handleCopy, formatTime }
  }
}
</script>
