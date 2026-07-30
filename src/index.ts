import { DurableObject } from "cloudflare:workers";

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

export class InspectaLlamaDO extends DurableObject {
  sessions: Set<WebSocket>;
  activeInspectors: Map<string, number> = new Map();
  lastInspectedPrompts: string[] = [];
  evalCache: Map<string, { data: any; expiresAt: number }> = new Map();
  activeJobs: Set<string> = new Set();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Set<WebSocket>();
    
    // Load persisted lastInspectedPrompts string array from DO storage
    this.ctx.blockConcurrencyWhile(async () => {
      const storedPrompts = await this.ctx.storage.get<string[]>('lastInspectedPrompts');
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
    this.ctx.storage.put('lastInspectedPrompts', this.lastInspectedPrompts).catch(err => {
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
    if (!this.env.DB) return true;
    try {
      const user = await this.env.DB.prepare('SELECT credit_balance_cents, subscription_tier FROM users WHERE id = ?').bind(userId).first();
      if (!user) return false;
      if (user.subscription_tier === 'pro' || user.subscription_tier === 'enterprise') return true;
      const balance = (user.credit_balance_cents as number) || 0;
      if (balance < costCents) return false;
      const newBalance = balance - costCents;
      await this.env.DB.prepare('UPDATE users SET credit_balance_cents = ? WHERE id = ?').bind(newBalance, userId).run();
      return true;
    } catch (e) {
      console.error('Error deducting credits:', e);
      return false;
    }
  }

  // Resolve subscription tier and balance for authenticated user from D1 DB
  private async resolveTierAndBalance(userId: string): Promise<{tier: string, balance: number}> {
    if (!this.env.DB) return { tier: 'free', balance: 0 };
    try {
      const user = await this.env.DB.prepare('SELECT credit_balance_cents, subscription_tier FROM users WHERE id = ?').bind(userId).first();
      if (!user) return { tier: 'free', balance: 0 };
      return {
        tier: (user.subscription_tier as string) || 'free',
        balance: (user.credit_balance_cents as number) || 0
      };
    } catch (e) {
      console.error('Error resolving tier and balance:', e);
      return { tier: 'free', balance: 0 };
    }
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

      this.ctx.acceptWebSocket(server);
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

    // 3. Direct Edge Inference Router Evaluation Route (Mirrors Personalization /api/eval)
    if (url.pathname === '/api/eval' && request.method === 'POST') {
      try {
        const { targetUrl } = await request.json() as { targetUrl: string };
        if (!targetUrl) {
          return new Response(JSON.stringify({ error: "Missing targetUrl parameter" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const cacheKey = targetUrl.trim().toLowerCase();
        const now = Date.now();
        const cached = this.evalCache.get(cacheKey);

        // 1. Zero-Cost Cache Hit: Return cached evaluation if requested within 15 mins (900,000 ms)
        if (cached && cached.expiresAt > now) {
          return new Response(JSON.stringify({
            success: true,
            targetUrl,
            evaluation: cached.data,
            timestamp: new Date().toISOString(),
            cached: true,
            creditsDeducted: 0
          }), { headers: { 'Content-Type': 'application/json' } });
        }

        // 2. Concurrency Lock: Prevent parallel token burn for identical target URLs
        if (this.activeJobs.has(cacheKey)) {
          return new Response(JSON.stringify({ error: "Evaluation in progress for this URL. Please wait a moment." }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }

        this.activeJobs.add(cacheKey);

        let pageText = "";
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000);
          const pageRes = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          const rawHtml = await pageRes.text();
          pageText = rawHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
                             .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
                             .replace(/<[^>]+>/g, " ")
                             .replace(/\s+/g, " ")
                             .trim()
                             .substring(0, 3500);
        } catch (e: any) {
          pageText = `(Failed to fetch URL directly: ${e.message})`;
        }

        let evalResult = "";
        if (this.env.AI) {
          try {
            const aiRes = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
              messages: [
                { role: "system", content: "You are a Principal Web Architect & Security Evaluator. Analyze the provided webpage text content. Provide a concise evaluation covering: 1) Executive Summary, 2) Technical Stack & Architecture, 3) Performance & UX Quality, and 4) Strategic Recommendations." },
                { role: "user", content: `URL: ${targetUrl}\n\nWebpage Content Snippet:\n${pageText}` }
              ]
            });
            evalResult = aiRes.response || JSON.stringify(aiRes);
          } catch (e: any) {
            try {
              const aiRes = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                  { role: "system", content: "You are a Principal Web Architect & Security Evaluator." },
                  { role: "user", content: `URL: ${targetUrl}\n\nWebpage Content Snippet:\n${pageText}` }
                ]
              });
              evalResult = aiRes.response;
            } catch (fallbackErr) {
              evalResult = `### Edge Evaluation of ${targetUrl}\n\n**Raw Content Length**: ${pageText.length} characters\n\n**Extracted Content Snippet**:\n> ${pageText.substring(0, 500)}...`;
            }
          }
        } else {
          evalResult = `### Edge Evaluation of ${targetUrl}\n\n**Target URL**: ${targetUrl}\n**Page Content Length**: ${pageText.length} bytes extracted via Edge Worker.`;
        }

        // Cache evaluation for 15 minutes to save Neurons
        this.evalCache.set(cacheKey, { data: evalResult, expiresAt: now + 900000 });
        this.activeJobs.delete(cacheKey);

        return new Response(JSON.stringify({
          success: true,
          targetUrl,
          evaluation: evalResult,
          timestamp: new Date().toISOString(),
          creditsDeducted: 0
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 4. Multi-Tab Edge Browser Search Route
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const userId = request.headers.get('x-user-id') || request.headers.get('cf-connecting-ip') || 'anonymous';
        const userInfo = await this.resolveTierAndBalance(userId);
        const isPro = userInfo.tier === 'pro' || userInfo.tier === 'enterprise';
        if (!isPro && userInfo.balance <= 0) {
          return new Response(JSON.stringify({ error: "Insufficient credits. Please upgrade or refill credits on the Personalization Portal." }), { status: 402, headers: { 'Content-Type': 'application/json' } });
        }
        const { query, deepCrawl = true, mode = 'deep_reasoning' } = await request.json() as { query: string; deepCrawl?: boolean; mode?: string };

        // Record prompt evaluation for DO content-level deduplication across sessions
        this.recordPromptEvaluation(query);

        let searchResults: Array<{ title: string; url: string; snippet: string }> = [];
        let deepContentText = '';
        let screenshotBase64 = '';

        // Helper: Multi-Engine Web Search (DuckDuckGo + Wikipedia API fallback)
        const getSearchResults = async (q: string) => {
          const results: Array<{ title: string; url: string; snippet: string }> = [];
          
          // Engine 1: Wikipedia API Search
          try {
            const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json`;
            const wikiRes = await fetch(wikiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const wikiData = await wikiRes.json() as any;
            if (wikiData?.query?.search && Array.isArray(wikiData.query.search)) {
              for (const item of wikiData.query.search.slice(0, 4)) {
                const snippetText = item.snippet.replace(/<[^>]+>/g, '').trim();
                results.push({
                  title: item.title,
                  url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
                  snippet: snippetText
                });
              }
            }
          } catch (_) {}

          // Engine 2: DuckDuckGo Instant Answer API
          try {
            const jsonUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
            const jsonRes = await fetch(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const jsonData = await jsonRes.json() as any;
            if (jsonData?.RelatedTopics && Array.isArray(jsonData.RelatedTopics)) {
              for (const topic of jsonData.RelatedTopics) {
                if (topic.FirstURL && topic.Text && results.length < 6) {
                  results.push({
                    title: topic.Text.split(' - ')[0] || topic.Text.slice(0, 50),
                    url: topic.FirstURL,
                    snippet: topic.Text
                  });
                }
              }
            }
          } catch (_) {}

          return results;
        };

        searchResults = await getSearchResults(query);

        if (searchResults.length === 0) {
          searchResults = [
            {
              title: `Research Topic: ${query}`,
              url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}`,
              snippet: `Comprehensive AI synthesis on "${query}".`
            }
          ];
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
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
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

          // ── Step 3: Synthesis Engine via Llama 3.3 70B ──
          const fullPrompt = `USER OBJECTIVE: "${query}"

PRIMARY SEARCH SOURCES:
${searchResults.map(r => `• ${r.title} (${r.url}): ${r.snippet}`).join('\n')}

DEEP SCRAPED EXTRACTS:
${deepContentText}

INSTRUCTIONS:
You are InspectaLlama, a world-class Edge AI Research Engine. Synthesize an exhaustive, publication-grade markdown research report for "${query}". Break down the topic into structured sections (Executive Summary, Core Architecture/Mechanics, Critical Analysis).

Output ONLY valid JSON matching this schema:
{
  "executiveSummary": "# Research Synthesis: ${query}\\n\\nWrite an exhaustive, multi-paragraph markdown report with rich headers, detailed explanations, and technical depth.",
  "reasoningTrace": [{"step": 1, "description": "Information retrieval and claim verification"}],
  "claims": [{"statement": "Verified claim", "verbatimQuote": "Direct quote", "sourceTitle": "${searchResults[0]?.title || 'Source'}", "sourceUrl": "${searchResults[0]?.url || 'URL'}", "epistemicStatus": "Fact", "confidenceScore": 95}],
  "entities": [{"name": "${query}", "category": "Concept", "description": "Primary research objective"}],
  "disputes": [{"topic": "Key trade-off", "perspectiveA": "Advantage", "perspectiveB": "Limitation"}]
}`;

          let aiResponse: any = null;
          try {
            aiResponse = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
              max_tokens: 4096,
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
          } catch (modelErr) {
            console.log('Primary Llama 3.3 70B model failed, attempting 8B fallback...', modelErr);
            try {
              aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
                max_tokens: 4096,
                messages: [
                  {
                    role: 'system',
                    content: 'You are InspectaLlama Cognitive Synthesis Engine. Output strictly valid JSON.'
                  },
                  {
                    role: 'user',
                    content: fullPrompt
                  }
                ]
              });
            } catch (fallbackErr) {
              aiResponse = { response: `Search Synthesis Summary for "${query}":\n\n` + searchResults.map(s => `• ${s.title}: ${s.snippet}`).join('\n\n') };
            }
          }

          let parsedCognitiveData: any = {};
          try {
            let cleanJsonStr = (aiResponse?.response || '').trim();
            if (cleanJsonStr.startsWith('```json')) cleanJsonStr = cleanJsonStr.slice(7);
            if (cleanJsonStr.startsWith('```')) cleanJsonStr = cleanJsonStr.slice(3);
            if (cleanJsonStr.endsWith('```')) cleanJsonStr = cleanJsonStr.slice(0, -3);
            
            // Handle cases where the model returns JSON wrapped in an outer string or raw text
            const firstBrace = cleanJsonStr.indexOf('{');
            const lastBrace = cleanJsonStr.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
              cleanJsonStr = cleanJsonStr.substring(firstBrace, lastBrace + 1);
            }
            parsedCognitiveData = JSON.parse(cleanJsonStr);

            // If the model output double-stringified JSON inside executiveSummary, unwrap it
            if (typeof parsedCognitiveData === 'string') {
              try {
                parsedCognitiveData = JSON.parse(parsedCognitiveData);
              } catch (_) {}
            }
          } catch (e) {
            parsedCognitiveData = {
              executiveSummary: typeof aiResponse?.response === 'string' ? aiResponse.response : 'Synthesis completed.',
              reasoningTrace: [{ step: 1, description: "Standard single-pass cognitive reasoning completed." }],
              claims: [],
              entities: [],
              disputes: []
            };
          }

          let summaryText = "";
          if (typeof parsedCognitiveData === 'object' && parsedCognitiveData !== null && parsedCognitiveData.executiveSummary) {
            summaryText = String(parsedCognitiveData.executiveSummary);
          } else if (typeof aiResponse?.response === 'string' && aiResponse.response.trim().length > 0) {
            summaryText = aiResponse.response;
          } else {
            summaryText = `Search Synthesis for "${query}":\n\n` + searchResults.map(s => `• ${s.title}: ${s.snippet}`).join('\n\n');
          }

          return new Response(JSON.stringify({
            query,
            mode: 'deep_reasoning',
            synthesis: summaryText,
            reasoningTrace: Array.isArray(parsedCognitiveData.reasoningTrace) ? parsedCognitiveData.reasoningTrace : [{ step: 1, description: "Cognitive reasoning completed." }],
            claims: Array.isArray(parsedCognitiveData.claims) ? parsedCognitiveData.claims : [],
            entities: Array.isArray(parsedCognitiveData.entities) ? parsedCognitiveData.entities : [],
            disputes: Array.isArray(parsedCognitiveData.disputes) ? parsedCognitiveData.disputes : [],
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

          let aiResponse: any = null;
          try {
            aiResponse = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
              max_tokens: 4096,
              messages: [
                {
                  role: 'system',
                  content: 'You are InspectaLlama, an elite AI search engine. Synthesize a complete, structured response. Always conclude your final step or paragraph cleanly without cutting off mid-sentence.'
                },
                {
                  role: 'user',
                  content: fullPrompt
                }
              ]
            });
          } catch (modelErr) {
            try {
              aiResponse = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
                max_tokens: 4096,
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
            } catch (fallbackErr) {
              aiResponse = { response: `Search Results for "${query}":\n\n` + searchResults.map(s => `• ${s.title}: ${s.snippet}`).join('\n\n') };
            }
          }

          return new Response(JSON.stringify({
            query,
            mode: 'standard',
            synthesis: aiResponse?.response || 'Synthesis completed.',
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
        console.error('Unhandled search route error:', err);
        return new Response(JSON.stringify({ error: err.message || 'Search execution failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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

