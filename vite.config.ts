/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// One self-contained dist/index.html: works from file:// and from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  plugins: [vue(), viteSingleFile()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
