<script setup lang="ts">
/** Dialog syscalls (50–59): a modal that answers the waiting program. */
import { T, type Text } from '../../core/i18n'
import { t, tx } from '../i18n'
import { computed, nextTick, ref, watch } from 'vue'
import type { SessionHandle } from './useSession'

const props = defineProps<{ handle: SessionHandle }>()
const s = props.handle.session
const v = props.handle.version
const text = ref('')
const field = ref<HTMLInputElement | null>(null)
const first = ref<HTMLButtonElement | null>(null)

const dialog = computed(() => {
  void v.value
  return s.dialog
})

const LEVEL: Record<string, Text> = {
  error: T('错误', 'Error'),
  info: T('信息', 'Information'),
  warning: T('警告', 'Warning'),
  question: T('问题', 'Question'),
  plain: T('消息', 'Message'),
}

watch(dialog, async (d) => {
  text.value = ''
  await nextTick()
  if (d?.type === 'input') field.value?.focus()
  else first.value?.focus()
})
</script>

<template>
  <div v-if="dialog" class="veil" @keydown.esc="dialog.type === 'confirm' ? s.answerDialog({ type: 'confirm', choice: 'cancel' }) : dialog.type === 'input' ? s.answerDialog({ type: 'input', text: null }) : s.answerDialog({ type: 'message' })">
    <div class="box card" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <h4 id="dlg-title">
        {{ dialog.type === 'message' ? tx(LEVEL[dialog.level]!) : dialog.type === 'confirm' ? t('请确认', 'Please confirm') : t('请输入', 'Input') }}
        <span class="small muted">{{ t('（程序发起的对话框）', '(dialog opened by the program)') }}</span>
      </h4>
      <p class="msg">{{ dialog.message }}</p>
      <form v-if="dialog.type === 'input'" class="row" @submit.prevent="s.answerDialog({ type: 'input', text: text })">
        <input ref="field" v-model="text" class="inp" spellcheck="false" autocomplete="off" :aria-label="t('输入内容', 'Your input')" />
        <button class="btn primary" type="submit">{{ t('确定', 'OK') }}</button>
        <button class="btn" type="button" @click="s.answerDialog({ type: 'input', text: null })">{{ t('取消', 'Cancel') }}</button>
      </form>
      <div v-else-if="dialog.type === 'confirm'" class="row">
        <button ref="first" class="btn primary" @click="s.answerDialog({ type: 'confirm', choice: 'yes' })">{{ t('是', 'Yes') }}</button>
        <button class="btn" @click="s.answerDialog({ type: 'confirm', choice: 'no' })">{{ t('否', 'No') }}</button>
        <button class="btn" @click="s.answerDialog({ type: 'confirm', choice: 'cancel' })">{{ t('取消', 'Cancel') }}</button>
      </div>
      <div v-else class="row">
        <button ref="first" class="btn primary" @click="s.answerDialog({ type: 'message' })">{{ t('确定', 'OK') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 1000; /* above CodeMirror tooltips (500) */
  background: color-mix(in srgb, var(--bg) 60%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.box {
  width: min(420px, 100%);
  padding: 14px 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
h4 {
  margin: 0 0 6px;
  font-size: 14px;
}
.msg {
  white-space: pre-wrap;
  margin: 0 0 12px;
}
.row {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.row .inp {
  flex: 1;
  font-size: 13px;
  padding: 4px 8px;
}
</style>
