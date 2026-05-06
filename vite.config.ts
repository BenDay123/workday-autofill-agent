import { defineConfig } from 'vite';
import { crx, defineManifest } from '@crxjs/vite-plugin';

const manifest = defineManifest({
  manifest_version: 3,
  name: 'WorkdayAgent',
  version: '0.0.1',
  description: 'Auto-fill Workday job applications. Built in public.',
  permissions: ['storage', 'activeTab'],
  host_permissions: ['https://*.myworkdayjobs.com/*'],
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'WorkdayAgent',
  },
  content_scripts: [
    {
      matches: ['https://*.myworkdayjobs.com/*'],
      js: ['src/content.ts'],
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