import { formatFromBytes, formatFromPath, toDocument, toMarkdownBytes } from '@firecrawl/anydoc';
import { extname } from 'node:path';
import { hash } from './store.js';
import { editorialParts } from './document-annotations.js';

export const ANYDOC_VERSION = '0.2.4';
export type ExtractionStatus = 'ready' | 'needs_ocr' | 'unsupported_extraction' | 'encrypted' | 'malformed' | 'resource_limited' | 'failed';
export interface ConversionResult {
  schemaVersion: 1;
  converter: { name: string; version: string };
  format?: string;
  options: Record<string,unknown>;
  optionsHash: string;
  originalHash: string;
  status: ExtractionStatus;
  markdown?: string;
  structure?: { version: number; schema: string; data: unknown; assets: { id: number; hash: string; mediaType: string; originPart: string; file: string }[] };
  assets: { id: number; hash: string; mediaType: string; originPart: string; data: Uint8Array }[];
  editorial?: { version: 1; parts: {part:string;xml:string}[] };
  locators: string[];
  warnings: string[];
  error?: { code: string; message: string; pages?: number[]; pageCount?: number };
}
export interface DocumentConverter { convert(bytes: Uint8Array, name: string, mime: string): Promise<ConversionResult> }

// No hosted options, credentials, external links or embedded objects are executed.
export const anydocConverter: DocumentConverter = {
  async convert(bytes, name, mime) {
    const options = { ocr: 'reject' as const };
    const result: ConversionResult = { schemaVersion: 1, converter: { name: 'anydoc', version: ANYDOC_VERSION }, options, optionsHash: hash(JSON.stringify(options)), originalHash: hash(bytes), status: 'ready', assets: [], locators: ['markdown_lines'], warnings: [] };
    try {
      const detected = formatFromBytes(bytes), extension = extname(name).toLowerCase();
      const csv=mime==='text/csv'||mime==='application/csv';
      const native = !detected && !csv && ['.md','.markdown','.txt','.json','.tsv','.html','.htm'].includes(extension);
      if (native) {
        result.converter = { name: 'pikobot-native', version: '1' }; result.format = extension.slice(1);
        const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
        if (text.includes('\0')) throw new Error('Binary content in native text input');
        if (extension === '.json') result.markdown = '```json\n' + JSON.stringify(JSON.parse(text), null, 2) + '\n```\n';
        else if (extension === '.tsv') {
          const rows = text.trimEnd().split(/\r?\n/).map(line => line.split('\t').map(cell => cell.replaceAll('|','\\|')));
          result.markdown = rows.map((row, i) => '| ' + row.join(' | ') + ' |' + (i === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n');
          result.warnings.push('TSV handler supports unquoted tab-separated cells, not spreadsheet calculation semantics.');
        } else if (['.html','.htm'].includes(extension)) {
          result.markdown = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/?(?:p|div|h[1-6]|br|tr|li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[entity]!));
          result.warnings.push('HTML text projection only; layout and assets are not extracted. External resources are not fetched.');
        } else result.markdown = text;
      } else {
        const format = detected ?? (extension === '.csv'||csv ? formatFromPath('document.csv') : null);
        result.format = format ?? undefined;
        if (!format) {
          result.status = mime.startsWith('image/') || Buffer.from(bytes).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'needs_ocr' : 'unsupported_extraction';
          result.warnings.push('Original retained. No searchable content extracted; existing vision/transcription routes are separate.');
          return result;
        }
        result.markdown = await toMarkdownBytes(bytes, format, options);
        if (format !== 'pdf') {
          const document = await toDocument(bytes, format);
          result.assets = document.assets.map(asset => ({ ...asset, hash: hash(asset.data) }));
          result.structure = { version: 1, schema: 'pikobot-anydoc-model', data: { blocks: document.blocks, notes: document.notes }, assets: result.assets.map(({ data: _data, ...asset }) => ({ ...asset, file: `assets/${asset.id}` })) };
          result.locators.push('package_part');
          if (JSON.stringify(document.blocks).includes('"kind":"unavailable"')) result.warnings.push('One or more image references are unavailable.');
          if (result.assets.length) result.markdown += '\n\n## Preserved assets (not interpreted)\n' + result.assets.map(asset => `[Asset ${asset.id}](pikobot-asset:${asset.id})`).join('\n');
        } else result.warnings.push('PDF extracted-text locations only; original pages, layout and image assets unavailable.');
        if (['xlsx','ods'].includes(format)) result.warnings.push('Readable tables only. Original cells, formulas, hidden content and exact workbook calculations are not established.');
        if(format==='docx') {
          const parts=editorialParts(bytes);
          const revisions=parts.some(part=>/<(?:\w+:)?(?:ins|del)\b/.test(part.xml));
          const comments=parts.filter(part=>part.part==='word/comments.xml');
          if(revisions||comments.length){result.editorial={version:1,parts};result.markdown='> Editorial limitation: this source contains proposed/deleted revisions or comments. Searchable text may include proposed insertions without approval labels; comments and deleted text are separate original-source annotations, not current statements. Consult original before deciding which claims are approved.\n\n'+result.markdown;result.warnings.push('Detected editorial revisions/comments; proposed text must not be assumed approved.');}
        }
        if (['doc','docx','odt','ppt','pptx','odp'].includes(format)) result.warnings.push('Comments, revision annotations and speaker-note completeness are not guaranteed; consult original for editorial distinctions.');
      }
      if (!result.markdown?.trim()) { result.status = 'malformed'; result.warnings.push('No searchable text. Empty output is not successful extraction.'); }
      if ((result.markdown?.match(/\uFFFD/g)?.length ?? 0) > 5) result.warnings.push('Repeated replacement characters; extraction may be unreadable.');
      if (Buffer.byteLength(result.markdown ?? '') > 4_000_000 || result.assets.reduce((sum, asset) => sum + asset.data.length, 0) > 40_000_000) { result.status = 'resource_limited'; result.markdown = undefined; result.structure = undefined; result.assets = []; }
    } catch (caught) {
      const error = caught as Error & { code?: string; pages?: number[]; pageCount?: number };
      const code = error.code ?? 'unknown';
      result.status = ({ needsOcr: 'needs_ocr', unsupported: 'unsupported_extraction', encrypted: 'encrypted', malformed: 'malformed', missingPart: 'malformed', resourceLimit: 'resource_limited' } as Record<string, ExtractionStatus>)[code] ?? 'failed';
      result.error = { code, message: error.message?.slice(0,1000) ?? 'Conversion failed', pages: error.pages, pageCount: error.pageCount };
      result.markdown = undefined; result.structure = undefined; result.assets = [];
    }
    return result;
  }
};
