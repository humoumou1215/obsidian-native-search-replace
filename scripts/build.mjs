import { copyFile } from 'node:fs/promises';

const source = new URL('../src/main.js', import.meta.url);
const output = new URL('../main.js', import.meta.url);

await copyFile(source, output);
