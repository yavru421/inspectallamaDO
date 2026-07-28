import puppeteer from '@cloudflare/puppeteer';

export interface Env {
  MY_BROWSER: Fetcher;
  AI: any;
  DB: D1Database;
  IDENTITY_CACHE: KVNamespace;
  INSPECTA_LLAMA_DO: DurableObjectNamespace;
}

export class InspectaLlamaDO implements DurableObject {
  state: DurableObjectState;
  env: Env;
  sessions: Set<WebSocket>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set<WebSocket>();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket Upgrade for Real-Time Streaming UI
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server);
      this.sessions.add(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP Search Route
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const { query, maxPages = 3 } = await request.json() as { query: string; maxPages?: number };

        // 1. Launch Headless Chrome on Cloudflare Edge
        const browser = await puppeteer.launch(this.env.MY_BROWSER);
        const page = await browser.newPage();

        // 2. Perform live search on DuckDuckGo HTML
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

        // 3. Extract search result links and body text
        const results = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('.result__a'));
          const snippets = Array.from(document.querySelectorAll('.result__snippet'));
          return anchors.slice(0, 5).map((a, i) => ({
            title: a.textContent?.trim() || '',
            url: (a as HTMLAnchorElement).href || '',
            snippet: snippets[i]?.textContent?.trim() || ''
          }));
        });

        // 4. Capture screenshot preview
        const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 50 });
        await page.close();

        // 5. Synthesize using Cloudflare Workers AI (Llama 3.3 70B)
        const contextText = results.map(r => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n');
        const aiResponse = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            {
              role: 'system',
              content: 'You are InspectaLlama, an elite AI search engine. Provide a clear, bulleted synthesis of the search query based strictly on the provided web results, complete with Markdown source citations.'
            },
            {
              role: 'user',
              content: `User Query: "${query}"\n\nWeb Results:\n${contextText}`
            }
          ]
        });

        return new Response(JSON.stringify({
          query,
          synthesis: aiResponse.response,
          sources: results,
          screenshotBase64: Buffer.from(screenshotBuffer).toString('base64'),
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    return new Response('InspectaLlama Durable Object Online', { status: 200 });
  }

  // Handle WebSocket messages
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ error: 'Invalid WS payload' }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.sessions.delete(ws);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route search & WebSocket requests to the singleton Durable Object instance
    if (url.pathname.startsWith('/api/') || request.headers.get('Upgrade') === 'websocket') {
      const id = env.INSPECTA_LLAMA_DO.idFromName('global_search_instance');
      const obj = env.INSPECTA_LLAMA_DO.get(id);
      return obj.fetch(request);
    }

    // Serve static Blazor WASM assets
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('InspectaLlama Worker Active', { status: 200 });
  }
};
