import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statistics } from './statistics.mjs';

const cases = [
  ['', { characters: 0, words: 0, lines: 0 }],
  ['Hello, world!', { characters: 13, words: 2, lines: 1 }],
  ['Hello,\nworld!', { characters: 13, words: 2, lines: 2 }],
  ['Hello\r\nworld', { characters: 12, words: 2, lines: 2 }],
  ['Hello\rworld', { characters: 11, words: 2, lines: 2 }],
  ['one\n', { characters: 4, words: 1, lines: 1 }],
  ['\n\n', { characters: 2, words: 0, lines: 2 }],
  [' \t\n', { characters: 3, words: 0, lines: 1 }],
  ['Hi 👋\nBye', { characters: 8, words: 3, lines: 2 }],
  ['e\u0301', { characters: 2, words: 1, lines: 1 }],
  [readFileSync(new URL('../assets/example.txt', import.meta.url), 'utf8'), { characters: 30, words: 4, lines: 2 }]
];
for (const [text, expected] of cases) assert.deepEqual(statistics({ text }), expected);
const invalidInputs = [null, [], {}, 'text', 42, { text: 7 }, { text: null }, { text: 'good', extra: true }];
for (const input of invalidInputs) assert.throws(() => statistics(input), /text string/);
console.log(JSON.stringify({ passed: true, cases: cases.length, invalidInputs: invalidInputs.length }));
