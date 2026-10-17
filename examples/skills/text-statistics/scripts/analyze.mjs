import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { statistics } from './statistics.mjs';

const help = `Text statistics — local, deterministic character, word and line counts.
Usage: node scripts/analyze.mjs [--file assets/example.txt] [--output outputs/report.json]
Default input: JSON on stdin, for example {"text":"Hello, world!"}.
--file reads UTF-8 text from a packaged assets/ file or an explicitly supplied inputs/ file instead of stdin.
--output saves the JSON report without overwriting existing files; stdout is still the same JSON.
--help shows this help without reading input or writing files.
Counts: Unicode code points, whitespace-separated words, and CR/LF/CRLF-delimited lines.
Empty text has zero lines; a final line ending does not create an extra line.
Errors go to stderr with exit code 1. No external packages, credentials or network calls.`;

function resourcePath(value, roots) {
  const parts = value.split('/');
  if (value.length > 500 || !roots.includes(parts[0]) || parts.some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) {
    throw new Error(`Use a relative file path inside ${roots.join('/ or ')}/, without traversal or control characters.`);
  }
  return value;
}

try {
  const { values } = parseArgs({ options: { file: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log(help);
  else {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const input = values.file !== undefined
      ? { text: decoder.decode(readFileSync(resourcePath(values.file, ['assets', 'inputs']))) }
      : JSON.parse(decoder.decode(readFileSync(0)));
    const result = statistics(input), output = JSON.stringify(result);
    if (values.output !== undefined) {
      const path = resourcePath(values.output, ['outputs']);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, output + '\n', { mode: 0o600, flag: 'wx' });
    }
    console.log(output);
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Input must be valid JSON containing a text string.' : error instanceof Error ? error.message : 'Text analysis failed.');
  process.exitCode = 1;
}
