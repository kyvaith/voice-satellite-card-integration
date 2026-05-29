/**
 * Copy browser vendor bundles that are loaded outside webpack chunks.
 *
 * HACS overwrites files on update but does not remove old versioned names,
 * so keep vendor filenames stable and cache-bust with query strings at
 * runtime instead.
 */
const fs = require('fs');
const path = require('path');

const dst = path.resolve(__dirname, '../custom_components/voice_satellite/frontend/vendor');
if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });

const files = [
  {
    src: path.resolve(__dirname, '../node_modules/hls.js/dist/hls.light.min.js'),
    dst: path.join(dst, 'hls.light.min.js'),
  },
];

for (const file of files) {
  fs.copyFileSync(file.src, file.dst);
}

console.log(`Vendor files copied: ${files.length} files`);
