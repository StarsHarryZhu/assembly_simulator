<script setup lang="ts">
/** Files the program can open with syscall 13 and that .include can name. They live in memory only. */
import { t } from '../i18n'
import { computed, ref } from 'vue'
import type { SessionHandle } from './useSession'
import { downloadBytes } from './files'

const props = defineProps<{ handle: SessionHandle }>()
const s = props.handle.session
const v = props.handle.version
const picker = ref<HTMLInputElement | null>(null)

const files = computed(() => {
  void v.value
  return s.files.list().map((name) => ({ name, size: s.files.size(name) }))
})

async function add(e: Event) {
  const list = (e.target as HTMLInputElement).files
  if (!list) return
  for (const f of Array.from(list)) s.files.write(f.name, new Uint8Array(await f.arrayBuffer()))
  ;(e.target as HTMLInputElement).value = ''
}

function save(name: string) {
  downloadBytes(name, s.files.read(name) ?? new Uint8Array())
}

function size(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}
</script>

<template>
  <div class="files">
    <div class="head">
      <span class="small muted">{{
        t(
          '程序用 syscall 13 打开的文件、.include 引用的文件都放在这里（只在本页内存里，刷新后清空）。',
          'Files the program opens with syscall 13 and files named by .include live here (in this page\'s memory only; a reload clears them).',
        )
      }}</span>
      <button class="btn" @click="picker?.click()">{{ t('添加文件', 'Add files') }}</button>
      <input ref="picker" type="file" multiple hidden @change="add" />
    </div>
    <p v-if="!files.length" class="muted small empty">{{ t('还没有文件。程序写出的文件也会出现在这里。', 'No files yet. Files the program writes appear here too.') }}</p>
    <div v-for="f in files" :key="f.name" class="row">
      <span class="mono name">{{ f.name }}</span>
      <span class="small muted">{{ size(f.size) }}</span>
      <button class="btn" @click="save(f.name)">{{ t('下载', 'Download') }}</button>
      <button class="btn" @click="s.files.remove(f.name)">{{ t('删除', 'Delete') }}</button>
    </div>
  </div>
</template>

<style scoped>
.files {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
}
.head {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 6px;
}
.empty {
  margin: 0;
  padding: 2px 4px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 6px;
  border-radius: 6px;
  background: var(--surface-2);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
</style>
