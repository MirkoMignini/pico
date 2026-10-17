import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { WebNetwork, WEB_BYTES, publicAddress, publicUrl } from '../src/web-network.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0))await close();});
it.each(['0.1.2.3','10.1.2.3','100.100.1.2','127.1.2.3','169.254.169.254','172.16.1.2','192.168.1.1','192.0.0.9','192.0.2.4','192.88.99.1','198.19.1.1','198.51.100.2','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:8.8.8.8','::ffff:127.0.0.1','64:ff9b::808:808','fc00::1','fe80::1','2001::1','2001:db8::1','2002:0808:0808::1','3fff::1'])('denies nonpublic address %s',address=>expect(publicAddress(address)).toBe(false));
it.each(['8.8.8.8','1.1.1.1','93.184.216.34','2606:4700:4700::1111','2001:4860:4860::8888'])('accepts global unicast %s',address=>expect(publicAddress(address)).toBe(true));
it.each(['file:///etc/passwd','ftp://example.com','https://user:secret@example.com','https://@example.com','http://localhost','http://service.local.','http://metadata.internal','http://2130706433','http://0x7f000001','http://0177.0.0.1','http://[::1]','https://example.com:8443','https://example.com\n'])('rejects forbidden URL %s',url=>expect(()=>publicUrl(url)).toThrow());
it('strips fragments and rejects all DNS answers if even one is nonpublic',async()=>{
  expect(publicUrl('https://example.com/page#section').href).toBe('https://example.com/page');
  const request=vi.spyOn(http,'request'),resolve=vi.fn(async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);
  await expect(new WebNetwork(resolve).get('http://public.example.org/')).rejects.toThrow('DNS address denied');expect(request).not.toHaveBeenCalled();
});
async function transport(handler: http.RequestListener) {
  const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const port=(server.address() as import('node:net').AddressInfo).port, original=http.request.bind(http), addresses:string[]=[];
  const route=vi.fn((url:URL,options:http.RequestOptions,callback:Parameters<typeof http.request>[2])=>{
    options.lookup!(url.hostname,{} as import('node:dns').LookupOneOptions,(_error,address,family)=>{addresses.push(address);expect(family).toBe(options.family);});
    const {lookup:_lookup,family:_family,...rest}=options;
    return original(`http://127.0.0.1:${port}${url.pathname}${url.search}`,{...rest,headers:{...options.headers,Host:url.host}},callback);
  });
  vi.spyOn(http,'request').mockImplementation(route as any);vi.spyOn(https,'request').mockImplementation(route as any);
  const resolve=vi.fn(async()=>[{address:'8.8.8.8',family:4}]);return {network:new WebNetwork(resolve),resolve,route,addresses};
}
it('pins each hop to validated DNS, handles relative redirects, and never sends cookies/auth/referrers',async()=>{
  const received:http.IncomingHttpHeaders[]=[];
  const t=await transport((request,response)=>{received.push(request.headers);if(request.url==='/start'){response.writeHead(302,{location:'/final'});response.end();}else{response.writeHead(200,{'content-type':'text/plain','set-cookie':'owner=unsafe'});response.end('Hello');}});
  const result=await t.network.get('http://public.example.org/start');
  expect(result).toMatchObject({url:'http://public.example.org/final',redirects:['http://public.example.org/final'],mime:'text/plain'});expect(result.bytes.toString()).toBe('Hello');
  expect(t.resolve).toHaveBeenCalledTimes(2);expect(t.addresses).toEqual(['8.8.8.8','8.8.8.8']);
  for(const headers of received){expect(headers).not.toHaveProperty('cookie');expect(headers).not.toHaveProperty('authorization');expect(headers).not.toHaveProperty('referer');expect(headers.host).toBe('public.example.org');}
});
it('rejects private redirect targets and rebinding between hops before making the second request',async()=>{
  const t=await transport((_request,response)=>{response.writeHead(302,{location:'/next'});response.end();});
  t.resolve.mockResolvedValueOnce([{address:'8.8.8.8',family:4}]).mockResolvedValueOnce([{address:'127.0.0.1',family:4}]);
  await expect(t.network.get('http://public.example.org/start')).rejects.toThrow('DNS address denied');expect(t.route).toHaveBeenCalledTimes(1);
});
it('rejects private and excessive redirects',async()=>{
  const t=await transport((request,response)=>{response.writeHead(302,{location:request.url==='/private'?'http://169.254.169.254/':`/loop${Date.now()}`});response.end();});
  await expect(t.network.get('http://public.example.org/private')).rejects.toThrow('redirect target denied');
  await expect(t.network.get('http://public.example.org/loop')).rejects.toThrow('redirect limit');expect(t.route).toHaveBeenCalledTimes(7);
});
it('sends Brave key only to its fixed origin/path, refuses every authenticated redirect and sanitizes remote errors',async()=>{
  const received:{url?:string;key?:string}[]=[];
  const t=await transport((request,response)=>{received.push({url:request.url,key:request.headers['x-subscription-token'] as string});response.writeHead(302,{location:'https://public.example.org/?key=do-not-leak'});response.end('do-not-leak');});
  await expect(t.network.get('https://public.example.org/',undefined,{braveKey:'synthetic-key'})).rejects.toThrow('destination denied');expect(t.route).not.toHaveBeenCalled();
  await expect(t.network.get('https://api.search.brave.com/res/v1/web/search?q=fixture',undefined,{braveKey:'synthetic-key'})).rejects.toThrow('redirect refused');expect(t.route).toHaveBeenCalledTimes(1);expect(received[0]?.key).toBe('synthetic-key');
});
it.each([['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]] as const)('streams and bounds %s decompression',async(encoding,compress)=>{
  const t=await transport((request,response)=>{response.writeHead(200,{'content-type':'text/plain','content-encoding':encoding});response.end(compress(Buffer.from(request.url==='/big'?'a'.repeat(WEB_BYTES+1):'Small text')));});
  expect((await t.network.get('http://public.example.org/small')).bytes.toString()).toBe('Small text');
  await expect(t.network.get('http://public.example.org/big')).rejects.toThrow('byte limit');
});
it('bounds streamed and declared bytes; rejects unsupported encoding, HTTP errors and truncated compressed bodies',async()=>{
  const t=await transport((request,response)=>{
    if(request.url==='/declared'){response.writeHead(200,{'content-length':WEB_BYTES+1});response.end();}
    else if(request.url==='/streamed'){response.writeHead(200,{'content-type':'text/plain'});response.end(Buffer.alloc(WEB_BYTES+1));}
    else if(request.url==='/encoding'){response.writeHead(200,{'content-encoding':'unrecognized'});response.end('do-not-leak');}
    else if(request.url==='/broken'){response.writeHead(200,{'content-encoding':'gzip'});response.end('do-not-leak');}
    else{response.writeHead(403);response.end('do-not-leak');}
  });
  for(const path of ['declared','streamed'])await expect(t.network.get(`http://public.example.org/${path}`)).rejects.toThrow('byte limit');
  await expect(t.network.get('http://public.example.org/encoding')).rejects.toThrow('Unsupported web');
  for(const path of ['broken','error']){const error=await t.network.get(`http://public.example.org/${path}`).catch(error=>error);expect(error.message).not.toContain('do-not-leak');}
});
it('cancels stalled DNS and bodies promptly without accepting late bytes',async()=>{
  const dns=new WebNetwork(()=>new Promise(()=>{})),controller=new AbortController();const lookup=dns.get('https://public.example.org/',controller.signal);controller.abort();await expect(lookup).rejects.toThrow();
  const t=await transport((_request,response)=>{response.writeHead(200,{'content-type':'text/plain'});response.write('partial');});
  const abort=new AbortController(), pending=t.network.get('http://public.example.org/',abort.signal);await new Promise(resolve=>setTimeout(resolve,30));abort.abort();await expect(pending).rejects.toThrow();
});
