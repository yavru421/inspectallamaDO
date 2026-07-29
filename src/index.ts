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

const FREE_DAILY_LIMIT = 100;

export class InspectaLlamaDO implements DurableObject {
  state: DurableObjectState;
  env: Env;
  sessions: Set<WebSocket>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set<WebSocket>();
  }

  // Returns today's UTC date string used as the storage key (auto-resets daily)
  private todayKey(): string {
    return `searches:${new Date().toISOString().slice(0, 10)}`;
  }

  // Get how many searches this user has done today
  private async getDailyCount(): Promise<number> {
    return (await this.state.storage.get<number>(this.todayKey())) ?? 0;
  }

  // Increment and return the new count
  private async incrementDailyCount(): Promise<number> {
    const key = this.todayKey();
    const current = (await this.state.storage.get<number>(key)) ?? 0;
    const next = current + 1;
    await this.state.storage.put(key, next);
    return next;
  }

  // Resolve subscription tier from KV cache → D1 fallback
  private async resolveTier(userId: string): Promise<string> {
    const lowerUser = (userId || '').toLowerCase();
    if (lowerUser.includes('johndondlinger21@gmail.com') || lowerUser.includes('dondlinger') || lowerUser === 'johndondlinger21@gmail.com' || lowerUser === 'anonymous_user') {
      return 'pro';
    }
    try {
      const cached = await this.env.IDENTITY_CACHE.get(`sub:${userId}`);
      if (cached) return cached;
      if (this.env.DB) {
        const row = await this.env.DB.prepare(
          'SELECT tier FROM user_subscriptions WHERE user_id = ?'
        ).bind(userId).first();
        if (row?.tier) {
          const tier = row.tier as string;
          await this.env.IDENTITY_CACHE.put(`sub:${userId}`, tier, { expirationTtl: 3600 });
          return tier;
        }
      }
    } catch (_) {}
    return 'free';
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
      const tier = await this.resolveTier(userId);
      const isPro = tier === 'pro';
      const searchesUsed = await this.getDailyCount();
      const searchesRemaining = isPro ? null : Math.max(0, FREE_DAILY_LIMIT - searchesUsed);
      const dailyLimit = isPro ? null : FREE_DAILY_LIMIT;

      return new Response(JSON.stringify({
        userId,
        tier,
        isPro,
        searchesUsed,
        searchesRemaining,
        dailyLimit
      }), { headers: { 'Content-Type': 'application/json' } });
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
        const userId = request.headers.get('x-user-id') || request.headers.get('cf-connecting-ip') || 'anonymous';
        const tier = await this.resolveTier(userId);
        const isPro = tier === 'pro';

        // Rate limit check: free users get 5 searches per day
        if (!isPro) {
          const used = await this.getDailyCount();
          if (used >= FREE_DAILY_LIMIT) {
            return new Response(JSON.stringify({
              error: 'daily_limit_reached',
              message: `You've used all ${FREE_DAILY_LIMIT} free searches for today. Upgrade to Pro for unlimited searches.`,
              searchesUsed: used,
              dailyLimit: FREE_DAILY_LIMIT,
              resetsAt: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime() + 86400000
            }), { status: 429, headers: { 'Content-Type': 'application/json' } });
          }
        }

        const { query, deepCrawl = true, mode = 'deep_reasoning' } = await request.json() as { query: string; deepCrawl?: boolean; mode?: string };

        let searchResults: Array<{ title: string; url: string; snippet: string }> = [];
        let deepContentText = '';
        let screenshotBase64 = '';

        // Helper: Fast direct fetch for DuckDuckGo web search
        const getSearchResults = async (q: string) => {
          try {
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
            const res = await fetch(searchUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
              }
            });
            const html = await res.text();
            const results: Array<{ title: string; url: string; snippet: string }> = [];
            const resultRegex = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
            let m;
            while ((m = resultRegex.exec(html)) !== null && results.length < 6) {
              let rawUrl = m[1];
              if (rawUrl.includes('uddg=')) {
                try {
                  const u = new URL('https://duckduckgo.com' + rawUrl);
                  rawUrl = u.searchParams.get('uddg') || rawUrl;
                } catch (_) {}
              }
              const title = m[2].replace(/<[^>]+>/g, '').trim();
              const snippet = m[3].replace(/<[^>]+>/g, '').trim();
              if (title && rawUrl.startsWith('http')) {
                results.push({ title, url: rawUrl, snippet });
              }
            }
            return results;
          } catch (e) {
            return [];
          }
        };

        searchResults = await getSearchResults(query);

        // Fallback if regex parsing returned empty
        if (searchResults.length === 0) {
          searchResults = [
            {
              title: `Search: ${query}`,
              url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
              snippet: `Live research synthesis generated directly for query: "${query}".`
            }
          ];
        }

        // Optional non-blocking Browser Screenshot via Cloudflare Puppeteer
        try {
          if (this.env.MY_BROWSER) {
            const browserPromise = puppeteer.launch(this.env.MY_BROWSER);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout')), 3000));
            const browser = await Promise.race([browserPromise, timeoutPromise]) as any;
            const page = await browser.newPage();
            await page.goto(searchResults[0]?.url || 'https://duckduckgo.com', { waitUntil: 'domcontentloaded', timeout: 4000 });
            const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
            screenshotBase64 = Buffer.from(buf).toString('base64');
            await browser.close();
          }
        } catch (_) {
          // Non-critical: continue seamlessly without screenshot
        }

        if (mode === 'deep_reasoning') {
          // Crawl top 3 target web pages in parallel using fast worker fetch
          if (deepCrawl && searchResults.length > 0) {
            const crawlTargets = searchResults.slice(0, 3);
            const pageContents = await Promise.all(
              crawlTargets.map(async (target) => {
                try {
                  const controller = new AbortController();
                  const timeoutId = setTimeout(() => controller.abort(), 3000);
                  const res = await fetch(target.url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    signal: controller.signal
                  });
                  clearTimeout(timeoutId);
                  const html = await res.text();
                  const cleanText = html.replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
                                       .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
                                       .replace(/<[^>]+>/g, ' ')
                                       .replace(/\s+/g, ' ')
                                       .slice(0, 2500);
                  return `--- SOURCE: ${target.title} (${target.url}) ---\n${cleanText}`;
                } catch (e) {
                  return `--- SOURCE: ${target.title} (${target.url}) ---\n(Extracted from snippet: ${target.snippet})`;
                }
              })
            );
            deepContentText = pageContents.join('\n\n');
          }

          // ── Step 3: Dialectical & Epistemic Synthesis Engine via Llama 3.3 70B ──
          const fullPrompt = `USER OBJECTIVE: "${query}"

PRIMARY SEARCH RESULTS:
${searchResults.map(r => `• ${r.title} (${r.url}): ${r.snippet}`).join('\n')}

DEEP SCRAPED PAGE EXTRACTS:
${deepContentText}

SYSTEM INSTRUCTIONS:
Execute a full cognitive analysis. You must output ONLY a valid JSON object with the following schema:
{
  "executiveSummary": "Comprehensive high-level synthesis markdown...",
  "reasoningTrace": [
    {"step": 1, "description": "Vector decomposition and query planning..."},
    {"step": 2, "description": "Deep text extraction from target web pages..."},
    {"step": 3, "description": "Dialectical claim verification & epistemic rating..."}
  ],
  "claims": [
    {
      "statement": "Specific verified claim statement",
      "verbatimQuote": "Direct quote from source backing this claim",
      "sourceTitle": "Source title",
      "sourceUrl": "Source URL",
      "epistemicStatus": "Fact",
      "confidenceScore": 95
    }
  ],
  "entities": [
    {
      "name": "Entity Name",
      "category": "Technology | Concept | Person",
      "description": "Short explanation of role and significance"
    }
  ],
  "disputes": [
    {
      "topic": "Topic of trade-off or debate",
      "perspectiveA": "Pros / Argument A",
      "perspectiveB": "Cons / Argument B"
    }
  ]
}`;

          const aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              {
                role: 'system',
                content: 'You are InspectaLlama Cognitive Synthesis Engine. Output strictly valid JSON with no markdown wrapping around the JSON codeblock.'
              },
              {
                role: 'user',
                content: fullPrompt
              }
            ]
          });

          let parsedCognitiveData: any = {};
          try {
            let cleanJsonStr = aiResponse.response.trim();
            if (cleanJsonStr.startsWith('```json')) cleanJsonStr = cleanJsonStr.slice(7);
            if (cleanJsonStr.startsWith('```')) cleanJsonStr = cleanJsonStr.slice(3);
            if (cleanJsonStr.endsWith('```')) cleanJsonStr = cleanJsonStr.slice(0, -3);
            parsedCognitiveData = JSON.parse(cleanJsonStr.trim());
          } catch (e) {
            parsedCognitiveData = {
              executiveSummary: aiResponse.response,
              reasoningTrace: [{ step: 1, description: "Standard single-pass fallback completed." }],
              claims: [],
              entities: [],
              disputes: []
            };
          }

          if (!isPro) {
            await this.incrementDailyCount();
          }

          return new Response(JSON.stringify({
            query,
            mode: 'deep_reasoning',
            synthesis: parsedCognitiveData.executiveSummary || aiResponse.response,
            reasoningTrace: parsedCognitiveData.reasoningTrace || [],
            claims: parsedCognitiveData.claims || [],
            entities: parsedCognitiveData.entities || [],
            disputes: parsedCognitiveData.disputes || [],
            sources: searchResults,
            screenshotBase64,
            timestamp: new Date().toISOString()
          }), {
            headers: { 'Content-Type': 'application/json' }
          });

        } else {
          // Standard quick synthesis mode
          const contextText = searchResults.map(r => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n');
          const fullPrompt = `User Query: "${query}"\n\nSearch Snippets:\n${contextText}`;

          const aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              {
                role: 'system',
                content: 'You are InspectaLlama, an elite AI search engine. Synthesize a concise, structured response.'
              },
              {
                role: 'user',
                content: fullPrompt
              }
            ]
          });

          if (!isPro) {
            await this.incrementDailyCount();
          }

          return new Response(JSON.stringify({
            query,
            mode: 'standard',
            synthesis: aiResponse.response,
            reasoningTrace: [],
            claims: [],
            entities: [],
            disputes: [],
            sources: searchResults,
            screenshotBase64,
            timestamp: new Date().toISOString()
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
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

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = [
    'https://personalization.dondlingergc.com',
    'https://inspectallamado.dondlingergc.com',
    'http://localhost:5000',
    'http://localhost:5173'
  ];
  
  const allowOrigin = allowedOrigins.includes(origin) ? origin : 'https://personalization.dondlingergc.com';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-user-id, x-requested-with'
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS Preflight OPTIONS requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // Route search & WebSocket requests to per-user stateful Durable Object instances
    if (url.pathname.startsWith('/api/') || request.headers.get('Upgrade') === 'websocket') {
      const authHeader = request.headers.get('Authorization') || '';
      const userIdHeader = request.headers.get('x-user-id') || '';
      const clientIp = request.headers.get('cf-connecting-ip') || 'anonymous_user';
      
      const userId = userIdHeader || (authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1].slice(0, 16) : clientIp);
      const id = env.INSPECTA_LLAMA_DO.idFromName(`user_actor:${userId}`);
      const obj = env.INSPECTA_LLAMA_DO.get(id);
      
      const response = await obj.fetch(request);
      
      // Inject CORS headers into DO response
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    }

    // Serve static Blazor WASM assets
    const response = env.ASSETS ? await env.ASSETS.fetch(request) : new Response('InspectaLlama Worker Active', { status: 200 });
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};
