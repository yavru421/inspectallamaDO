# 🦙 InspectaLlamaDO — Next-Gen AI Web Search Engine

InspectaLlama is a full-stack, edge-native AI Web Search Engine & Research Assistant built with **C# .NET Blazor WebAssembly**, **Cloudflare Durable Objects (`InspectaLlamaDO`)**, **Cloudflare Browser Rendering (`@cloudflare/puppeteer`)**, and **Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)**.

## 🌟 Key Features

* **Headless Browser Scraping**: Executes JavaScript and renders dynamic client-side DOMs on Cloudflare Edge nodes using `@cloudflare/puppeteer`.
* **Stateful Durable Object Actor**: `InspectaLlamaDO` orchestrates multi-source web searches, manages WebSocket streaming, and caches search trajectories.
* **AI Synthesis & Vision Captures**: Streamed summaries from Llama 3.3 70B alongside live JPEG browser screenshot previews of inspected web pages.
* **Zero-Liability Architecture (ZLA)**: $0.00 host server overhead, hosted on Cloudflare Pages/Workers with 95%+ gross profit margins on Pro subscriptions ($9.99/mo).

## 🚀 Quick Start

### Local Development
```bash
# 1. Install dependencies
npm install

# 2. Run Cloudflare Worker & Durable Object locally
npm run dev
```

### Deployment Workflow
Following Cloudflare CI rules, deployments are triggered via git push:
```bash
git add .
git commit -m "feat: initial inspectallamaDO foundation"
git push origin main
```
