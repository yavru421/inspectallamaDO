export interface Env {
  MY_BROWSER: Fetcher;
  AI: any;
  DB: D1Database;
  IDENTITY_CACHE: KVNamespace;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ASSETS?: Fetcher;
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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. User Status Route
    if (url.pathname === '/api/user/status') {
      const userId = request.headers.get('x-user-id') || 'anonymous';
      let tier = 'free';
      let balance = 0;
      if (env.DB) {
        try {
          const user = await env.DB.prepare('SELECT credit_balance_cents, subscription_tier FROM users WHERE id = ?').bind(userId).first();
          if (user) {
            tier = (user.subscription_tier as string) || 'free';
            balance = (user.credit_balance_cents as number) || 0;
          }
        } catch (_) {}
      }
      const isPro = tier === 'pro' || tier === 'enterprise';
      return new Response(JSON.stringify({
        userId,
        tier,
        isPro,
        searchesUsed: 0,
        searchesRemaining: isPro ? null : Math.floor(balance / 5),
        dailyLimit: null,
        activeCount: 1
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. Live Telemetry
    if (url.pathname === '/api/inspect/live') {
      let recentUniquePrompts: any[] = [];
      if (env.DB) {
        try {
          const { results } = await env.DB.prepare(
            'SELECT prompt_text, COUNT(*) as query_count FROM inspections GROUP BY LOWER(TRIM(prompt_text)) ORDER BY RANDOM() LIMIT 50'
          ).all();
          recentUniquePrompts = results || [];
        } catch (_) {}
      }
      return new Response(JSON.stringify({
        status: 'online',
        architecture: 'stateless-edge-router',
        activeCount: 1,
        recentUniquePrompts,
        timestamp: new Date().toISOString()
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        }
      });
    }

    // 3. Stateless Edge Streaming / Direct Evaluation Endpoint
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      try {
        const { prompt, systemPrompt } = await request.json() as { prompt: string; systemPrompt?: string };
        const aiRes = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: systemPrompt || 'You are a stateless edge AI router.' },
            { role: 'user', content: prompt }
          ]
        });
        return new Response(JSON.stringify({ success: true, response: aiRes.response || aiRes }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // 4. Visual Sequential Thinking / Forking Edge Router
    if (url.pathname === '/api/forks' && request.method === 'POST') {
      try {
        const { context } = await request.json() as { context: string };
        const forkPrompt = `Context: "${context}"
INSTRUCTIONS: Generate exactly 4 distinct, actionable sequential thinking forks to advance the workflow.
1. Deep Dive (Implementation)
2. Edge Case (Alternative / Bypass)
3. Automation (Scaling / Scripting)
4. Audit (Critique / Bottlenecks)

Output JSON strictly matching: {"forks": ["Fork 1...", "Fork 2...", "Fork 3...", "Fork 4..."]}`;

        const aiRes = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: 'Output strictly valid JSON.' },
            { role: 'user', content: forkPrompt }
          ]
        });

        let parsed: any = { forks: [] };
        try {
          let str = aiRes.response || '';
          const firstBrace = str.indexOf('{');
          const lastBrace = str.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1) {
            str = str.substring(firstBrace, lastBrace + 1);
          }
          parsed = JSON.parse(str);
        } catch (_) {
          parsed = { forks: [aiRes.response] };
        }

        return new Response(JSON.stringify({ success: true, forks: parsed.forks }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Fallback to static asset serving
    const response = env.ASSETS ? await env.ASSETS.fetch(request) : new Response('InspectaLlama Edge Router Active', { status: 200 });
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};
