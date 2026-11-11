import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { sourceHash } from './source-hash.mjs'

/**
 * The built page's Content-Security-Policy. Scripts come only from this site; the page may talk to itself (its data
 * file) and to the two testnet RPCs, nothing else. Added at build time only: the dev server injects inline scripts.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self' https://rpc.testnet.near.org https://rpc.testnet.fastnear.com",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const csp = (): Plugin => ({
  name: 'keyhole-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

/** docs/build.json: the fingerprint of the source this build came from (source-hash.mjs). */
const buildStamp = (): Plugin => {
  let root = ''
  return {
    name: 'keyhole-build-stamp',
    apply: 'build',
    configResolved: (config) => { root = config.root },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: `${JSON.stringify({ source: sourceHash(root) })}\n` })
    },
  }
}

// GitHub Pages serves docs/ at /keyhole/: relative asset paths and a hash router work under any prefix.
export default defineConfig({
  base: './',
  plugins: [react(), csp(), buildStamp()],
  build: {
    outDir: '../docs',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
  },
})
