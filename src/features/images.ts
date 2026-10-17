import type { ExtensionAPI } from '../extensions.js';
import { ImageGenerateSchema, ImageShowSchema } from '../images.js';
import { jsonTool } from './tools.js';

export default function images(pico: ExtensionAPI): void {
  jsonTool(pico,'image_show','Show an existing retained PNG/JPEG/GIF/WebP in this TUI conversation. Exactly one attachmentId or documentId, optional document revision. Local preview only: no URL/host path, generation, model inspection or Telegram send; pixels depend on terminal support. Do not call telegram_send just to display here. Trusted retained owner foreground only.',ImageShowSchema,async (args,context) => context.services.showImage(args));
  jsonTool(pico,'image_generate','Create an owner-requested synthetic PNG, not web search, editing or factual evidence. prompt max 6000 characters; optional square/landscape/portrait. Explicitly enabled metered OpenAI API service/credentials, not a chat subscription. One attempt per run; never retry uncertain/cancelled requests or fall back. Only the prompt is sent, not chat/memory. Saves a private source-linked attachment for TUI/download; metadata is not pixel inspection or proof of prompt adherence. Telegram work attempts actual-sender delivery: inspect its separate receipt, never resend uncertain delivery. Trusted retained owner foreground only.',ImageGenerateSchema,async (args,context) => {
    const image=await context.services.generateImage(args);
    if(context.source.channel!=='telegram')return image;
    try {
      const result=await context.callTool('telegram_send',{attachmentId:image.attachmentId});
      return {...image,delivery:JSON.parse((result.content[0] as {text:string}).text)};
    } catch {
      return {...image,delivery:{accepted:false,uncertain:true,note:'Image saved, but Telegram delivery was not confirmed. Do not automatically resend; accepted messages may already exist.'}};
    }
  });
}
