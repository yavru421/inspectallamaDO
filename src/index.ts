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
  activeInspectors: Map<string, number> = new Map();
  lastInspectedPrompts: string[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set<WebSocket>();
    
    // Load persisted lastInspectedPrompts string array from DO storage
    this.state.blockConcurrencyWhile(async () => {
      const storedPrompts = await this.state.storage.get<string[]>('lastInspectedPrompts');
      if (storedPrompts) {
        this.lastInspectedPrompts = storedPrompts;
      }
    });
  }

  private recordPromptEvaluation(prompt: string) {
    const normalized = prompt.trim().toLowerCase();
    if (!normalized) return;
    
    // Filter out previous occurrence if present, append to front
    this.lastInspectedPrompts = [normalized, ...this.lastInspectedPrompts.filter(p => p !== normalized)].slice(0, 200);
    
    // Persist to DO storage non-blockingly
    this.state.storage.put('lastInspectedPrompts', this.lastInspectedPrompts).catch(err => {
      console.log('Error persisting lastInspectedPrompts:', err);
    });
  }

  private isPromptRecentlyEvaluated(prompt: string): boolean {
    const normalized = prompt.trim().toLowerCase();
    return this.lastInspectedPrompts.includes(normalized);
  }

  private updatePresence(clientId?: string | null): number {
    const now = Date.now();
    if (clientId) {
      this.activeInspectors.set(clientId, now);
    }
    // Prune sessions older than 10 seconds (10000 ms)
    for (const [id, lastTime] of this.activeInspectors.entries()) {
      if (now - lastTime > 10000) {
        this.activeInspectors.delete(id);
      }
    }
    return Math.max(1, this.activeInspectors.size, this.ctx.getWebSockets().length);
  }

  private async deductCredits(userId: string, costCents: number): Promise<boolean> {
    // Unconditionally grant heavy usage access to ALL accounts with ZERO overage risk on Cloudflare Workers AI free tier
    return true;
  }

  // Resolve subscription tier and balance for all users
  private async resolveTierAndBalance(userId: string): Promise<{tier: string, balance: number}> {
    // Unconditionally treat EVERY user as Pro with unlimited balance
    return { tier: 'pro', balance: 999999 };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Track active HTTP session presence via clientId sliding window
    const clientId = url.searchParams.get('clientId');
    const activeCount = this.updatePresence(clientId);

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
      const userInfo = await this.resolveTierAndBalance(userId);
      const isPro = userInfo.tier === 'pro' || userInfo.tier === 'enterprise';

      return new Response(JSON.stringify({
        userId,
        tier: userInfo.tier,
        isPro,
        searchesUsed: 0,
        searchesRemaining: isPro ? null : Math.floor(userInfo.balance / 5),
        dailyLimit: null,
        activeCount
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 2. Live Telemetry & Durable Object Presence Route
    if (url.pathname === '/api/inspect/live') {
      let recentUniquePrompts: any[] = [];
      if (this.env.DB) {
        try {
          const { results } = await this.env.DB.prepare(
            'SELECT prompt_text, COUNT(*) as query_count FROM inspections GROUP BY LOWER(TRIM(prompt_text)) ORDER BY RANDOM() LIMIT 50'
          ).all();
          recentUniquePrompts = results || [];
        } catch (e) {
          // If D1 table is not created yet, fall back to in-memory prompt history
          recentUniquePrompts = this.lastInspectedPrompts.map(p => ({ prompt_text: p, query_count: 1 }));
        }
      } else {
        recentUniquePrompts = this.lastInspectedPrompts.map(p => ({ prompt_text: p, query_count: 1 }));
      }

      return new Response(JSON.stringify({
        status: 'online',
        activeCount,
        recentUniquePrompts,
        cachedEvaluationsCount: this.lastInspectedPrompts.length,
        timestamp: new Date().toISOString()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        }
      });
    }

    // 4. Multi-Tab Edge Browser Search Route
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const userId = request.headers.get('x-user-id') || request.headers.get('cf-connecting-ip') || 'anonymous';
        const userInfo = await this.resolveTierAndBalance(userId);
        const isPro = userInfo.tier === 'pro' || userInfo.tier === 'enterprise';
        const { query, deepCrawl = true, mode = 'deep_reasoning' } = await request.json() as { query: string; deepCrawl?: boolean; mode?: string };

        // Record prompt evaluation for DO content-level deduplication across sessions
        this.recordPromptEvaluation(query);

        const searchCostCents = mode === 'deep_reasoning' ? 15 : 5;

        // Rate limit check: deduct credits if not pro
        if (!isPro) {
          const success = await this.deductCredits(userId, searchCostCents);
          if (!success) {
            return new Response(JSON.stringify({
              error: 'insufficient_funds',
              message: `Insufficient Edge Credits. Cost is $${(searchCostCents / 100).toFixed(2)}. Please refill credits on the Personalization portal.`,
              searchesUsed: 0,
              dailyLimit: null,
              resetsAt: null
            }), { status: 402, headers: { 'Content-Type': 'application/json' } });
          }
        }

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

        // Screenshot disabled to prevent Worker isolate hangs

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

          const aiResponse = await this.env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
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

          const aiResponse = await this.env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
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
      
      let userId = userIdHeader || clientIp;
      if (authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const payloadBase64 = token.split('.')[1];
          const payloadStr = atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'));
          const payload = JSON.parse(payloadStr);
          userId = payload.id || payload.sub || payload.user_id || userId;
        } catch (e) {
          // ignore parsing error, fallback to IP
        }
      }
      const id = env.INSPECTA_LLAMA_DO.idFromName(`user_actor:${userId}`);
      const obj = env.INSPECTA_LLAMA_DO.get(id);
      
      const response = await obj.fetch(request);
      
      // Inject CORS headers and Anti-Caching Headers for /api/inspect/live into DO response
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      
      if (url.pathname === '/api/inspect/live') {
        newHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      }

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

