import type { ExtensionAPI } from '../src/extensions.js';

export default function (pikobot: ExtensionAPI) {
  pikobot.registerTool({
    name: 'word_count',
    label: 'Word count',
    description: 'Count words in supplied text.',
    parameters: pikobot.Type.Object({ text: pikobot.Type.String({ maxLength: 10_000 }) }, { additionalProperties: false }),
    async execute(_callId, { text }) {
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      return { content: [{ type: 'text', text: String(words) }], details: { words } };
    }
  });
}
