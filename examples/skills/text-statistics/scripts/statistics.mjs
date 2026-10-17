export function statistics(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'text') || typeof input.text !== 'string') {
    throw new Error('Input must be an object containing only a text string.');
  }
  const { text } = input;
  let characters = 0, words = 0, lineBreaks = 0;
  for (const _ of text) characters++;
  for (const _ of text.matchAll(/\S+/gu)) words++;
  for (const _ of text.matchAll(/\r\n|[\r\n]/gu)) lineBreaks++;
  return { characters, words, lines: text.length ? lineBreaks + Number(!/[\r\n]$/u.test(text)) : 0 };
}
