import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
let embedder: FeatureExtractionPipeline | undefined;
let tail: Promise<unknown> = Promise.resolve();
parentPort!.on('message', (request: { id: string; kind: 'embedding' | 'pdf'; texts?: string[]; purpose?: string; bytes?: Uint8Array }) => {
  tail = tail.then(async () => {
    try {
      let result: unknown;
      if (request.kind === 'embedding') {
        embedder ??= await pipeline('feature-extraction', workerData.model, { revision: workerData.revision, cache_dir: workerData.cacheDir, dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
        const vectors = await embedder(request.texts!.map(text => `${request.purpose === 'query' ? 'query' : 'passage'}: ${text.slice(0, 4000)}`), { pooling: 'mean', normalize: true });
        result = vectors.tolist();
      } else {
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = getDocument({ data: request.bytes!, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, disableStream: true });
        const pdf = await task.promise;
        try {
          if (pdf.numPages > 100) throw new Error('PDF page limit exceeded');
          let text = '';
          for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n), content = await page.getTextContent();
            text += content.items.map(item => 'str' in item ? item.str : '').join(' ') + '\n';
            if (text.length > 100_000) break;
          }
          result = text.slice(0, 100_000);
        } finally { await task.destroy(); }
      }
      parentPort!.postMessage({ id: request.id, result });
    } catch (error) { parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message.slice(0, 1000) : 'Processing failed' }); }
  });
});
