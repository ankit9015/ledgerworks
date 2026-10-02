// Checks that every relative link in the given Markdown files points to an existing file or folder
// (anchors are not checked). Exits 1 and lists the broken ones.
//   node scripts/check-links.mjs README.md ledgerline/README.md
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

let broken = 0;
let total = 0;
for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    total++;
    const clean = decodeURIComponent(target.split('#')[0]);
    if (!existsSync(path.resolve(path.dirname(file), clean))) {
      broken++;
      console.log(`BROKEN in ${file}: ${target}`);
    }
  }
}
console.log(`${total} relative links checked, ${broken} broken`);
process.exit(broken ? 1 : 0);
