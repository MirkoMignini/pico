import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

export const WEB_BYTES = 2_000_000;
const denied = new BlockList(), globalV6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) denied.addSubnet(address, prefix, 'ipv6');
globalV6.addSubnet('2000::',3,'ipv6');
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address,'ipv4') : family === 6 && globalV6.check(address,'ipv6') && !denied.check(address,'ipv6');
}
export function publicUrl(raw: string): URL {
  if (!raw || raw.length > 4000 || !/^https?:\/\//i.test(raw) || /[\\\s\x00-\x1f\x7f]/.test(raw)) throw new Error('Invalid public web URL');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid public web URL'); }
  if (!['http:','https:'].includes(url.protocol) || url.port || url.username || url.password || /^https?:\/\/[^/]*@/i.test(raw)) throw new Error('Only public HTTP(S) URLs without credentials or nonstandard ports are allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
  if (!hostname || !hostname.includes('.') && !isIP(hostname) || /(?:^|\.)(?:localhost|local|internal|lan|home|onion|test|invalid|arpa)$/.test(hostname) || isIP(hostname) && !publicAddress(hostname)) throw new Error('Private/reserved web target denied');
  url.hash = ''; return url;
}
export interface WebResponse { url: string; redirects: string[]; mime: string; contentType?: string; bytes: Buffer }
export type WebLookup = (hostname: string) => Promise<{address:string;family:number}[]>;
export class WebNetwork {
  constructor(private resolve: WebLookup = hostname => lookup(hostname,{all:true,order:'verbatim'})) {}
  async get(raw: string, parent?: AbortSignal, credentials?: { braveKey: string }): Promise<WebResponse> {
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(parent ? [parent] : [])]);
    let url = publicUrl(raw); const redirects: string[] = [];
    // A service key is only accepted at the fixed Brave endpoint, never at a caller-selected URL.
    if (credentials && (url.origin !== 'https://api.search.brave.com' || url.pathname !== '/res/v1/web/search')) throw new Error('Search credential destination denied');
    for (;;) {
      signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g,'');
      const addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await new Promise<{address:string;family:number}[]>((resolve,reject) => {
        const cancel = () => reject(new Error('Web DNS lookup cancelled'));
        signal.addEventListener('abort',cancel,{once:true});
        this.resolve(hostname).then(resolve,() => reject(new Error('Web DNS lookup failed'))).finally(() => signal.removeEventListener('abort',cancel));
        if (signal.aborted) cancel();
      });
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(entry => !publicAddress(entry.address) || isIP(entry.address) !== entry.family)) throw new Error('Private/reserved DNS address denied');
      const selected = addresses.find(entry=>entry.family===4) ?? addresses[0]!;
      let response: http.IncomingMessage;
      try {
        response = await new Promise<http.IncomingMessage>((resolve,reject) => {
          const request = (url.protocol === 'https:' ? https : http).request(url, {
            agent:false, family:selected.family, signal,
            // Pin this socket to a checked address; keep the URL hostname for Host/SNI/certificate checks.
            lookup: (_hostname,_options,callback) => callback(null,selected.address,selected.family),
            headers:{'User-Agent':'Pico/0.1.0','Accept':credentials?'application/json':'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9','Accept-Encoding':'gzip, deflate, br',...(credentials?{'X-Subscription-Token':credentials.braveKey}:{})}
          },resolve);
          request.once('error',() => reject(new Error('Web network/TLS request failed'))); request.end();
        });
        const status = response.statusCode ?? 0;
        if ([301,302,303,307,308].includes(status)) {
          const location = response.headers.location; response.destroy();
          if (credentials || !location || redirects.length >= 5) throw new Error('Web redirect refused (credential, missing location or redirect limit)');
          try { url = publicUrl(new URL(location,url).href); } catch { throw new Error('Web redirect target denied'); }
          redirects.push(url.href); continue;
        }
        if (status < 200 || status >= 300) { response.destroy(); throw new Error(`Web HTTP ${status}; response body not exposed`); }
        const length = response.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > WEB_BYTES)) { response.destroy(); throw new Error('Web response exceeds byte limit'); }
        const encoding = response.headers['content-encoding']?.toLowerCase() ?? 'identity';
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
        if (!decoder && encoding !== 'identity') { response.destroy(); throw new Error('Unsupported web content encoding'); }
        let wire = 0, decoded = 0; const chunks: Buffer[] = [];
        const boundWire = new Transform({transform(chunk:Buffer,_encoding,callback) { wire += chunk.length; callback(wire > WEB_BYTES ? new Error('Web response exceeds byte limit') : null,chunk); }});
        const collect = new Writable({write(chunk:Buffer,_encoding,callback) { decoded += chunk.length; if (decoded > WEB_BYTES) callback(new Error('Web decompressed response exceeds byte limit')); else { chunks.push(chunk); callback(); } }});
        await pipeline([response,boundWire,...(decoder?[decoder]:[]),collect],{signal});
        return {url:url.href,redirects,contentType:response.headers['content-type'],mime:(response.headers['content-type']??'').split(';')[0]!.trim().toLowerCase(),bytes:Buffer.concat(chunks)};
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && /^Web |^Private\/|^Unsupported web/.test(error.message)) throw error;
        throw new Error('Web response failed; remote details not exposed');
      }
    }
  }
}
