---
layout: home

title: Your space. Your assistant.
hero:
  name: Pikobot
  text: Your space.<br>Your assistant.
  tagline: A self-hosted personal assistant that remembers what matters. Chat in your terminal or on Telegram. Keep your data in your own instance.
  image:
    src: /favicon.svg
    alt: Pikobot, a smiling teal speech bubble with a violet spark
  actions:
    - theme: brand
      text: Get up and running →
      link: /INSTALLATION
    - theme: alt
      text: Try without credentials
      link: /DEMO

features:
  - title: Remember with sources
    details: Recall facts and preferences with original evidence. Correct what changes and forget what should not stay.
    link: /MEMORY
    linkText: How memory works
  - title: Make room for your day
    details: Notes, checklists, documents, appointments and durable reminders, all through ordinary conversation.
    link: /FEATURES
    linkText: Explore everyday features
  - title: Connect only what you need
    details: Add Telegram, Google, MCP servers or reusable skills when you want them. No integrations to configure just to start.
    link: /SETUP
    linkText: Choose your setup
---

## From zero to first conversation

1. **[Install & launch](./INSTALLATION.md).** Use the pinned Node and pnpm versions, install from a reviewed checkout, then initialize your private instance once and open chat. macOS and Linux are supported; Docker is optional.
2. **[Configure your model](./SETUP.md).** Open `/setup`, choose your account/model and enter credentials only in the separate masked dialogs. Configure memory embeddings explicitly. Selected providers can charge for chat, extraction and embeddings.
3. **Start small.** Ask “Create a packing checklist with passport, charger and jacket.” Use `/new` for a fresh saved conversation and `/help` for controls. Closing the terminal client leaves the daemon running.

::: warning Early development, honest limits
Pikobot is not production-hardened. Self-hosted does not mean offline or sandboxed. Check sources and receipts for important work. Read the [security model](./SECURITY.md) and [verification limits](./TESTING.md) before relying on it.
:::

Need it running after login? Follow [per-user services](./INSTALLATION.md#install-an-explicit-per-user-service). Want it on your phone? Set up [Telegram](./SETUP.md#telegram) when you are ready.
