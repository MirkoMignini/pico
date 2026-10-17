import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { publicUrl } from './web-network.js';

export interface WebHit { title: string; url: string; snippet: string; age?: string }
export interface WebArticle { title: string; text: string; extraction: 'readability' | 'fallback' | 'text'; truncated: boolean; warnings: string[] }
const clean = (text: string) => text.replace(/\s+/g,' ').trim();
const destination = (value: string, base: string): string | undefined => { try { return publicUrl(new URL(value,base).href).href; } catch { return undefined; } };
export function duckduckgoResults(html: string | Uint8Array, limit: number): WebHit[] {
  const dom = new JSDOM(typeof html==='string'?html:Buffer.from(html),{url:'https://html.duckduckgo.com/html/',contentType:'text/html; charset=utf-8'}), document = dom.window.document;
  try {
    if (document.querySelector('.anomaly-modal, #challenge-form, form[action*="anomaly"]')) throw new Error('DuckDuckGo challenge; search unavailable, no automatic provider fallback');
    const hits: WebHit[] = [], seen = new Set<string>();
    for (const result of document.querySelectorAll('.result')) {
      if (result.matches('.result--ad') || result.querySelector('.badge--ad')) continue;
      const link = result.querySelector<HTMLAnchorElement>('.result__a'); if (!link) continue;
      let url: URL; try { url = new URL(link.href); } catch { continue; }
      if (['duckduckgo.com','html.duckduckgo.com'].includes(url.hostname) && url.pathname.startsWith('/l/')) { try { url = new URL(url.searchParams.get('uddg') ?? ''); } catch { continue; } }
      const target = destination(url.href,'https://html.duckduckgo.com/'); if (!target || seen.has(target)) continue;
      seen.add(target); hits.push({title:clean(link.textContent??'').slice(0,300),url:target,snippet:clean(result.querySelector('.result__snippet')?.textContent??'').slice(0,700)});
      if (hits.length >= limit) break;
    }
    // shortcut: DDG's public HTML is not a stable API; update selectors if its format changes, never use Instant Answers as full search.
    if (!hits.length && !document.querySelector('.no-results, .result--no-result')) throw new Error('DuckDuckGo returned no recognizable search results; challenge or HTML format change');
    return hits;
  } finally { dom.window.close(); }
}
export function braveResults(body: string, limit: number): WebHit[] {
  let data: unknown; try { data = JSON.parse(body); } catch { throw new Error('Invalid Brave search response'); }
  const results = (data as {web?:{results?:unknown}} | null)?.web?.results;
  if (!Array.isArray(results)) throw new Error('Invalid Brave search results');
  const hits: WebHit[] = [], seen = new Set<string>();
  for (const item of results) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.title !== 'string' || typeof item.description !== 'string') continue;
    const url = destination(item.url,'https://api.search.brave.com'); if (!url || seen.has(url)) continue;
    const dom = new JSDOM('');
    try {
      const plain = (html:string) => { const element = dom.window.document.createElement('div'); element.innerHTML=html; return clean(element.textContent??''); };
      const age = typeof item.age === 'string' ? item.age : typeof item.page_age === 'string' ? item.page_age : undefined;
      hits.push({title:plain(item.title).slice(0,300),url,snippet:plain(item.description).slice(0,700),...(age?{age:age.slice(0,100)}:{})}); seen.add(url);
    } finally { dom.window.close(); }
    if (hits.length >= limit) break;
  }
  return hits;
}
function bounded(title: string, text: string, extraction: WebArticle['extraction'], warnings: string[] = []): WebArticle {
  if (!text.trim()) throw new Error('No readable web content; page JavaScript/login/OCR is not supported');
  const truncated = text.length > 80_000 || Buffer.byteLength(text) > 190_000;
  text = text.slice(0,80_000);
  while (Buffer.byteLength(text) > 190_000) text = text.slice(0,Math.floor(text.length*0.9));
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0,-1);
  return {title:title.slice(0,500),text,extraction,truncated,warnings:[...warnings,...(truncated?['Captured text is truncated; unavailable remainder is not evidence.']:[])]};
}
export function webArticle(body: string | Uint8Array, url: string, mime: string, contentType = mime): WebArticle {
  if (['text/plain','text/markdown'].includes(mime)) {
    const charset=/charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]??'utf-8';
    let text:string;try{text=typeof body==='string'?body:new TextDecoder(charset,{fatal:true}).decode(body);}catch{throw new Error('Web text encoding unavailable/invalid');}
    return bounded(url,text,'text');
  }
  if (!['text/html','application/xhtml+xml'].includes(mime)) throw new Error('Unsupported web type; only HTML/plain text/Markdown pages are fetched');
  const dom = new JSDOM(typeof body==='string'?body:Buffer.from(body),{url,contentType}), document = dom.window.document;
  try {
    if (document.querySelector('#challenge-form, .anomaly-modal, #cf-challenge-running, #challenge-running')) throw new Error('Page challenge; content unavailable');
    document.querySelectorAll('script,style,noscript,iframe,object,embed,form,svg,template').forEach(node => node.remove());
    document.querySelectorAll('a[href]').forEach(node => { const target=destination(node.getAttribute('href')!,url); target?node.setAttribute('href',target):node.removeAttribute('href'); });
    if (!document.body) throw new Error('No readable HTML/XHTML body');
    const title = clean(document.title);
    // Adapted from Mario Zechner's MIT pi-skills/brave-search content.js; see docs/licenses/pi-skills.txt.
    const article = new Readability(document.cloneNode(true) as Document,{maxElemsToParse:50_000}).parse();
    const main = document.querySelector('main,article,[role="main"],.content,#content') ?? document.body;
    if (!article?.content) document.querySelectorAll('nav,header,footer,aside').forEach(node => node.remove());
    const turndown = new TurndownService({headingStyle:'atx',codeBlockStyle:'fenced'}); turndown.use(gfm);
    turndown.addRule('images',{filter:'img',replacement:(_content,node) => (node as HTMLElement).getAttribute('alt')??''});
    turndown.addRule('emptyLinks',{filter:node => node.nodeName==='A' && !node.textContent?.trim(),replacement:()=>''});
    const text = turndown.turndown(article?.content ?? main.innerHTML).replace(/\n{3,}/g,'\n\n').trim();
    return bounded(article?.title || title || url,text,article?.content?'readability':'fallback',article?.content?[]:['Fallback extraction may include navigation or omit content.']);
  } finally { dom.window.close(); }
}
