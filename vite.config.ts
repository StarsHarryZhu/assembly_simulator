/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { version } from './package.json' with { type: 'json' }

// One self-contained dist/index.html: works from file:// and from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [vue(), viteSingleFile()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
