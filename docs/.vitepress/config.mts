import { defineConfig } from 'vitepress';

const repository = 'https://github.com/MirkoMignini/pico';

export default defineConfig({
  title: 'Pico',
  description: 'Your space. Your assistant. Get started with a self-hosted personal assistant with memory.',
  lang: 'en-US',
  base: '/pico/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['ATTACHMENTS-RESEARCH.md', 'COMPARISON.md'],
  sitemap: { hostname: 'https://mirkomignini.github.io/pico/' },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/pico/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#0f766e' }],
  ],
  markdown: {
    config(md) {
      const normalizeLink = md.normalizeLink;
      // Repository-only sources stay on GitHub rather than becoming broken site links.
      md.normalizeLink = (url) => normalizeLink(url.startsWith('../') ? `${repository}/blob/main/${url.slice(3)}` : url);
    },
  },
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Get started', link: '/INSTALLATION' },
      { text: 'Guides', link: '/FEATURES' },
      { text: 'Security', link: '/SECURITY' },
    ],
    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Install & run', link: '/INSTALLATION' },
          { text: 'Accounts & setup', link: '/SETUP' },
          { text: 'Try the offline demo', link: '/DEMO' },
        ],
      },
      {
        text: 'Use Pico',
        items: [
          { text: 'Everyday features', link: '/FEATURES' },
          { text: 'Memory & forgetting', link: '/MEMORY' },
          { text: 'Documents, notes & lists', link: '/KNOWLEDGE' },
          { text: 'Telegram & channels', link: '/CHANNELS' },
          { text: 'Family collaboration', link: '/FAMILY' },
        ],
      },
      {
        text: 'Connect & extend',
        items: [
          { text: 'Google services', link: '/GOOGLE' },
          { text: 'MCP servers', link: '/MCP' },
          { text: 'Skills', link: '/SKILLS' },
        ],
      },
      {
        text: 'Operate safely',
        items: [
          { text: 'Security & privacy', link: '/SECURITY' },
          { text: 'Deployment & backups', link: '/DEPLOYMENT' },
          { text: 'Testing & limits', link: '/TESTING' },
        ],
      },
      {
        text: 'For developers',
        collapsed: true,
        items: [
          { text: 'Development', link: '/DEVELOPMENT' },
          { text: 'Extension SDK', link: '/SDK' },
          { text: 'Contributing', link: `${repository}/blob/main/CONTRIBUTING.md` },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: { pattern: `${repository}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    outline: { level: [2, 3] },
    footer: {
      message: `Open source. Self-hosted. <a href="${repository}/blob/main/LICENSE">MIT licensed.</a>`,
      copyright: 'Pico · Your space. Your assistant.',
    },
  },
});
