// CSV Senja — the program the harness runs: `node /bot/main.ts` (Node 22).
//
// It reads every case from /input/cases.json (a JSON array of {id, input}) and
// writes /output/answers.json: a JSON array of the answers, one per case and in
// the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.
//
// Each case is answered by run() from solve.js, the fast drop-in for
// csv-reader 1.0.0, and the answers are serialised by the native JSON
// serialiser. Building the JSON by hand in this program was measured slower
// than letting run() build the values and JSON.stringify serialise them, so
// this driver keeps that split: the parser moves in slices and the serialiser
// runs in native code.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the house baseline runs with --no-incremental-marking,
// and an entry may tune V8's flags the same way).
setFlagsFromString('--no-incremental-marking');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

// Read as a Buffer and decode it: faster than reading the file as UTF-8 text.
const raw = readFileSync(join(INPUT_DIR, 'cases.json'));
const cases = JSON.parse(raw.toString('utf8')) as {
  id: string;
  input: unknown;
}[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
