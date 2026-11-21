import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before the parser modules are imported so
// all of their work runs under it (the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags the same way).
setFlagsFromString('--no-incremental-marking');

const { transcodeCase, makeScanner, NeedFallback } = (await import(
  new URL('./transcode.js', import.meta.url).href
)) as typeof import('./transcode.js');
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: { text: string; header: boolean }) => unknown;
};

const here = dirname(fileURLToPath(import.meta.url));
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'));
const scanner = makeScanner(raw);
const out = Buffer.allocUnsafe(raw.length * 2 + 1000000);
let o = 0;
out[o++] = 0x5b; // [

let first = true;
let pos = 0;
while (true) {
  const ti = raw.indexOf('"text":"', pos);
  if (ti === -1) break;
  const ts = ti + 8;
  const te = raw.indexOf('","header":', ts);
  if (te === -1) break;
  const hdr = raw[te + 11] === 0x74; // 't' = true
  if (!first) out[o++] = 0x2c; // ,
  first = false;
  try {
    o = transcodeCase(raw, scanner, ts, te, hdr, out, o);
  } catch (e) {
    if (e instanceof NeedFallback) {
      const text = JSON.parse(raw.subarray(ts - 1, te + 1).toString('utf8'));
      const ans = run({ text, header: hdr });
      o += out.write(JSON.stringify(ans), o, 'utf8');
    } else {
      throw e;
    }
  }
  pos = te + 11;
}
out[o++] = 0x5d; // ]

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), out.subarray(0, o));
