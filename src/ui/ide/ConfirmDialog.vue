<script setup lang="ts">
/** A question inside the page with a few answers, used instead of the browser's blocking confirm(). */
import { nextTick, onMounted, ref } from 'vue'

export interface Choice {
  value: string
  label: string
  primary?: boolean
}

defineProps<{ message: string; choices: Choice[] }>()
/** null: dismissed (Escape or a click outside). */
const emit = defineEmits<{ answer: [value: string | null] }>()
const box = ref<HTMLElement | null>(null)
onMounted(() => nextTick(() => box.value?.querySelector<HTMLButtonElement>('.primary')?.focus()))
</script>

<template>
  <div class="veil" @click.self="emit('answer', null)" @keydown.esc="emit('answer', null)">
    <div ref="box" class="box card" role="alertdialog" aria-modal="true" aria-describedby="confirm-msg">
      <p id="confirm-msg" class="msg">{{ message }}</p>
      <div class="row">
        <button v-for="c in choices" :key="c.value" class="btn" :class="{ primary: c.primary }" @click="emit('answer', c.value)">{{ c.label }}</button>
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
  width: min(460px, 100%);
  padding: 14px 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.msg {
  white-space: pre-wrap;
  margin: 0 0 12px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
</style>
