import { inflateRawSync } from 'node:zlib';

// Read only bounded editorial XML, not a general ZIP extractor. Names never become filesystem paths.
export function editorialParts(bytes:Uint8Array):{part:string;xml:string}[] {
  const buffer=Buffer.from(bytes),parts:{part:string;xml:string}[]=[];
  const end=buffer.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  if(end<0||end+22>buffer.length)return parts;
  const count=buffer.readUInt16LE(end+10);let offset=buffer.readUInt32LE(end+16);
  if(count>4096)return parts;
  for(let i=0;i<count;i++){
    if(offset+46>buffer.length||buffer.readUInt32LE(offset)!==0x02014b50)return parts;
    const compressed=buffer.readUInt32LE(offset+20),size=buffer.readUInt32LE(offset+24),nameLength=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42),method=buffer.readUInt16LE(offset+10);
    if(offset+46+nameLength+extra+comment>buffer.length)return parts;
    const part=buffer.subarray(offset+46,offset+46+nameLength).toString('utf8');offset+=46+nameLength+extra+comment;
    if(!/^word\/(document|comments)\.xml$/.test(part)||size>2_000_000||compressed>2_000_000||local+30>buffer.length)continue;
    if(buffer.readUInt32LE(local)!==0x04034b50)continue;
    const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);if(start+compressed>buffer.length)continue;
    try{
      const raw=buffer.subarray(start,start+compressed),data=method===8?inflateRawSync(raw,{maxOutputLength:2_000_000}):method===0?raw:null;
      if(data&&data.length===size)parts.push({part,xml:data.toString('utf8')});
    }catch{/* The authoritative original remains available; inspection never bypasses converter limits. */}
  }return parts;
}
