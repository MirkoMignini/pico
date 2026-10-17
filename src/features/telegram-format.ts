import { Marked, type Token } from '@earendil-works/pi-tui';
import type { MessageEntity } from 'grammy/types';

const markdown = new Marked({ gfm: true });
markdown.use({ extensions: [{ name: 'spoiler', level: 'inline', start: text => text.indexOf('||'), tokenizer(text) {
  const match = /^\|\|([^\n]+?)\|\|/.exec(text);
  if (match) return { type: 'spoiler', raw: match[0], tokens: this.lexer.inlineTokens(match[1]!) };
} }] });
export interface TelegramText { text: string; entities: MessageEntity[] }

export function splitTelegram(text: string, max = 4000): string[] {
  if (!Number.isInteger(max) || max < 2) throw new Error('Telegram chunk limit must be at least two UTF-16 units');
  const result: string[] = [];
  let part = '';
  for (const char of text) { if (part.length + char.length > max) { result.push(part); part = ''; } part += char; }
  if (part) result.push(part);
  return result.length ? result : ['(No text response)'];
}

// Explicit UTF-16 entities avoid MarkdownV2 escaping and preserve formatting across chunk boundaries.
export function telegramMarkdown(source: string): TelegramText {
  let text = '';
  const entities: MessageEntity[] = [];
  let inQuote = false;
  const append = (value: string) => { text += value; };
  const styled = (entity: { type: MessageEntity['type']; url?: string; language?: string }, body: () => void) => {
    const offset = text.length; body();
    if (text.length > offset) entities.push({ ...entity, offset, length: text.length - offset } as MessageEntity);
  };
  const walk = (tokens: Token[], depth = 0): void => {
    for (const token of tokens) {
      if (depth > 32) { append(token.raw); continue; }
      const inner = () => walk('tokens' in token ? token.tokens ?? [] : [], depth + 1);
      switch (token.type) {
        case 'space': case 'checkbox': break;
        case 'heading': styled({ type: 'bold' }, inner); append('\n\n'); break;
        case 'paragraph': inner(); append('\n\n'); break;
        case 'strong': styled({ type: 'bold' }, inner); break;
        case 'em': styled({ type: 'italic' }, inner); break;
        case 'del': styled({ type: 'strikethrough' }, inner); break;
        case 'spoiler': styled({ type: 'spoiler' }, inner); break;
        case 'codespan': styled({ type: 'code' }, () => append(token.text)); break;
        case 'code': styled({ type: 'pre', language: token.lang?.split(/\s/)[0] }, () => append(token.text)); append('\n\n'); break;
        case 'blockquote':
          if (inQuote) inner();
          else { inQuote = true; styled({ type: 'blockquote' }, inner); inQuote = false; }
          break;
        case 'link':
          if (/^(?:https?:\/\/|mailto:|tg:\/\/)/i.test(token.href)) styled({ type: 'text_link', url: token.href }, inner);
          else append(token.raw);
          break;
        case 'image': append(`${token.text || 'Image'} (${token.href})`); break;
        case 'br': append('\n'); break;
        case 'hr': append('———\n\n'); break;
        case 'list':
          token.items.forEach((item: typeof token.items[number], index: number) => {
            append(`${token.ordered ? `${Number(token.start) + index}.` : '•'} ${item.task ? item.checked ? '☑ ' : '☐ ' : ''}`);
            walk(item.tokens, depth + 1); if (!text.endsWith('\n')) append('\n');
          }); append('\n'); break;
        case 'table':
          styled({ type: 'pre' }, () => {
            for (const cells of [token.header, ...token.rows]) {
              cells.forEach((cell: typeof token.header[number], index: number) => { if (index) append(' | '); walk(cell.tokens, depth + 1); });
              append('\n');
            }
          }); append('\n'); break;
        case 'text': if (token.tokens) inner(); else append(token.text); break;
        case 'escape': append(token.text); break;
        default: append(token.raw); // HTML is literal evidence, never interpreted as Telegram markup.
      }
    }
  };
  try { walk(markdown.lexer(source)); } catch { return { text: source, entities: [] }; }
  text = text.trimEnd();
  const protectedRanges = entities.filter(entity => ['code', 'pre'].includes(entity.type) && !entities.some(parent => parent !== entity && parent.type === 'pre' && parent.offset <= entity.offset && parent.offset + parent.length >= entity.offset + entity.length));
  const safe = entities.flatMap(entity => {
    if (['code', 'pre'].includes(entity.type) && !protectedRanges.includes(entity)) return [];
    let ranges = [{ from: entity.offset, to: Math.min(text.length, entity.offset + entity.length) }];
    if (!['code', 'pre'].includes(entity.type)) for (const block of protectedRanges) {
      const start = block.offset, end = start + block.length;
      ranges = ranges.flatMap(range => end <= range.from || start >= range.to ? [range] : [
        { from: range.from, to: Math.min(range.to, start) }, { from: Math.max(range.from, end), to: range.to }
      ]);
    }
    return ranges.filter(range => range.to > range.from).map(range => ({ ...entity, offset: range.from, length: range.to - range.from }));
  }).sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text, entities: safe };
}

export function telegramParts(source: string, max = 4000): TelegramText[] {
  const rendered = telegramMarkdown(source);
  let offset = 0;
  return splitTelegram(rendered.text, max).map(text => {
    const start = offset; offset += text.length;
    const entities = rendered.entities.flatMap(entity => {
      const from = Math.max(start, entity.offset), to = Math.min(offset, entity.offset + entity.length);
      return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
    }).slice(0, 100);
    return { text, entities };
  });
}
