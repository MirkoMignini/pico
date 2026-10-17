export async function responseBytes(response: Response, maxBytes = 8_000_000): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Integration request: HTTP ${response.status}`),{status:response.status}); }
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Integration response exceeds byte limit'); }
  if (!response.body) throw new Error('Integration response missing');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try { while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>maxBytes)throw new Error('Integration response exceeds byte limit');chunks.push(part.value);} }
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
export async function responseJson<T>(response: Response, maxBytes = 8_000_000): Promise<T> {
  const bytes=await responseBytes(response,maxBytes);
  try{return JSON.parse(bytes.toString('utf8')) as T;}
  catch{throw new Error('Integration returned malformed JSON');}
}
export const requestSignal = (signal?: AbortSignal, timeoutMs=30_000): AbortSignal => AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
