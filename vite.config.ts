import { defineConfig } from 'vite';
import { crx, defineManifest } from '@crxjs/vite-plugin';

const manifest = defineManifest({
  manifest_version: 3,
  name: 'WorkdayAgent',
  version: '0.0.22',
  description: 'Auto-fill Workday job applications. Built in public.',
  permissions: ['storage', 'activeTab', 'clipboardWrite'],
  host_permissions: ['https://*.myworkdayjobs.com/*'],
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'WorkdayAgent',
  },
  content_scripts: [
    {
      matches: ['https://*.myworkdayjobs.com/*'],
      js: ['src/content.ts'],
      run_at: 'document_idle',
    },
    {
      // v2 main-world script. Runs in the page's own JS world so it
      // can see React fibers and invoke combobox handlers directly.
      // NOTE: HMR is not supported for world: 'MAIN' (per @crxjs/vite-plugin docs);
      // changes to src/injected/main.ts require manual extension reload.
      matches: ['https://*.myworkdayjobs.com/*'],
      js: ['src/injected/main.ts'],
      world: 'MAIN',
      run_at: 'document_start',
    },
  ],
});

export default defineConfig({
  plugins: [
    crx({ manifest }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});