import puppeteer from '@cloudflare/puppeteer';

export interface Env {
  MY_BROWSER: Fetcher;
  AI: any;
  DB: D1Database;
  IDENTITY_CACHE: KVNamespace;
  INSPECTA_LLAMA_DO: DurableObjectNamespace;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ASSETS?: Fetcher;
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

    // 1. HTTP User Status Route
    if (url.pathname === '/api/user/status') {
      const userId = request.headers.get('x-user-id') || 'anonymous';
      
      let subTier = 'free';
      try {
        const cached = await this.env.IDENTITY_CACHE.get(`sub:${userId}`);
        if (cached) {
          subTier = cached;
        } else if (this.env.DB) {
          const row = await this.env.DB.prepare('SELECT tier FROM user_subscriptions WHERE user_id = ?').bind(userId).first();
          if (row?.tier) {
            subTier = row.tier as string;
            await this.env.IDENTITY_CACHE.put(`sub:${userId}`, subTier, { expirationTtl: 3600 });
          }
        }
      } catch (e) {
        // Fallback to free tier on cache miss or table initialization
      }

      return new Response(JSON.stringify({ userId, tier: subTier, isPro: subTier === 'pro' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Stripe Checkout Session Route
    if (url.pathname === '/api/stripe/checkout' && request.method === 'POST') {
      const userId = request.headers.get('x-user-id') || 'anonymous';
      const stripeKey = this.env.STRIPE_SECRET_KEY;

      if (!stripeKey) {
        return new Response(JSON.stringify({
          error: 'Stripe secret key not configured. Set STRIPE_SECRET_KEY secret in Cloudflare Dashboard.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      try {
        const params = new URLSearchParams();
        params.append('payment_method_types[]', 'card');
        params.append('mode', 'subscription');
        params.append('line_items[0][price_data][currency]', 'usd');
        params.append('line_items[0][price_data][product_data][name]', 'InspectaLlama Pro Pass');
        params.append('line_items[0][price_data][product_data][description]', 'Unlimited Deep Web Search, Live Screenshots, and 70B Llama AI Model Access.');
        params.append('line_items[0][price_data][unit_amount]', '999'); // $9.99
        params.append('line_items[0][price_data][recurring][interval]', 'month');
        params.append('line_items[0][quantity]', '1');
        params.append('success_url', `${url.origin}/?payment=success`);
        params.append('cancel_url', `${url.origin}/?payment=cancel`);
        params.append('client_reference_id', userId);

        const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${stripeKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        const session = await stripeRes.json() as any;
        return new Response(JSON.stringify({ url: session.url }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 3. Stripe Webhook Route
    if (url.pathname === '/api/stripe/webhook' && request.method === 'POST') {
      try {
        const body = await request.text();
        const event = JSON.parse(body);

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const userId = session.client_reference_id || 'anonymous';

          // Update D1 database & KV identity cache
          if (this.env.DB) {
            await this.env.DB.prepare(
              'INSERT INTO user_subscriptions (user_id, tier, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET tier = ?, updated_at = CURRENT_TIMESTAMP'
            ).bind(userId, 'pro', 'pro').run();
          }
          await this.env.IDENTITY_CACHE.put(`sub:${userId}`, 'pro', { expirationTtl: 86400 });
        }

        return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400 });
      }
    }

    // 4. Multi-Tab Edge Browser Search Route
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const { query, deepCrawl = true } = await request.json() as { query: string; deepCrawl?: boolean };

        // Launch Headless Chrome on Cloudflare Edge Node
        const browser = await puppeteer.launch(this.env.MY_BROWSER);
        const searchPage = await browser.newPage();

        // Perform live search query
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded' });

        // Extract top search result anchors
        const searchResults = await searchPage.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('.result__a'));
          const snippets = Array.from(document.querySelectorAll('.result__snippet'));
          return anchors.slice(0, 4).map((a, i) => ({
            title: a.textContent?.trim() || '',
            url: (a as HTMLAnchorElement).href || '',
            snippet: snippets[i]?.textContent?.trim() || ''
          }));
        });

        // Capture primary search page screenshot
        const screenshotBuffer = await searchPage.screenshot({ type: 'jpeg', quality: 50 });
        await searchPage.close();

        // Multi-Tab Deep Content Scraping (Crawl top 2 target URLs in parallel)
        let deepContentText = '';
        if (deepCrawl && searchResults.length > 0) {
          const crawlTargets = searchResults.slice(0, 2);
          const pageContents = await Promise.all(
            crawlTargets.map(async (target) => {
              try {
                const targetPage = await browser.newPage();
                await targetPage.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 5000 });
                const text = await targetPage.evaluate(() => {
                  return document.body.innerText.slice(0, 1500);
                });
                await targetPage.close();
                return `[Source: ${target.title}]\n${text}`;
              } catch (e) {
                return `[Source: ${target.title}]\n(Could not fetch deep page text)`;
              }
            })
          );
          deepContentText = pageContents.join('\n\n');
        }

        // Synthesize results using Cloudflare Workers AI (Llama 3.3 70B)
        const contextText = searchResults.map(r => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n');
        const fullPrompt = `User Query: "${query}"\n\nSearch Snippets:\n${contextText}\n\nDeep Web Page Extracts:\n${deepContentText}`;

        const aiResponse = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            {
              role: 'system',
              content: 'You are InspectaLlama, an elite AI search engine. Synthesize a comprehensive, structured response with clear headings, key takeaways, and source citations.'
            },
            {
              role: 'user',
              content: fullPrompt
            }
          ]
        });

        return new Response(JSON.stringify({
          query,
          synthesis: aiResponse.response,
          sources: searchResults,
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

    // Route search & WebSocket requests to per-user stateful Durable Object instances
    if (url.pathname.startsWith('/api/') || request.headers.get('Upgrade') === 'websocket') {
      const userId = request.headers.get('x-user-id') || request.headers.get('cf-connecting-ip') || 'anonymous_user';
      const id = env.INSPECTA_LLAMA_DO.idFromName(`user_actor:${userId}`);
      const obj = env.INSPECTA_LLAMA_DO.get(id);
      return obj.fetch(request);
    }

    // Serve static Blazor WASM assets
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('InspectaLlama Worker Active', { status: 200 });
  }
};
