import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, Plugin } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function copyOrtWasmPlugin(): Plugin {
  return {
    name: 'copy-onnxruntime-wasm',
    closeBundle() {
      const srcDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      const destDir = path.resolve(__dirname, 'dist/ort-wasm');
      if (!fs.existsSync(srcDir)) return;
      fs.mkdirSync(destDir, { recursive: true });
      for (const entry of fs.readdirSync(srcDir)) {
        if (entry.endsWith('.wasm') || entry.endsWith('.mjs')) {
          fs.copyFileSync(path.join(srcDir, entry), path.join(destDir, entry));
        }
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), copyOrtWasmPlugin()],
    optimizeDeps: {
      exclude: ['onnxruntime-web'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Disable Vite HMR WebSocket in cloud preview container to prevent connection failures and white screens
      hmr: false,
      watch: null,
    },
  };
});
