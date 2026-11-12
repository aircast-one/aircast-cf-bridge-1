// Bundles aircastd's compiled Tailwind CSS into src/styles.js so the Worker can
// serve it at /assets/output.css and the watch player looks identical to the
// device's own /watch page.
//
// Usage: node scripts/bundle-css.mjs <path-to-aircastd/internal/web/assets/dist/output.css>
import fs from 'node:fs';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/bundle-css.mjs <output.css>');
  process.exit(1);
}
const css = fs.readFileSync(src, 'utf8');
const esc = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
const out =
  '// Auto-generated from aircastd internal/web/assets/dist/output.css — do not edit by hand.\n' +
  '// Regenerate: node scripts/bundle-css.mjs <path-to-output.css>\n' +
  'export const STYLES = `' + esc + '`;\n';
fs.writeFileSync(new URL('../src/styles.js', import.meta.url), out);
console.log('wrote src/styles.js (' + ((out.length / 1024) | 0) + 'KB)');
