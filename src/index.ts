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

    // 0. Auth / Session Check Proxy Route (Clean Guest Fallback without 401 noise)
    if (url.pathname === '/api/auth/me') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({
          isAuthenticated: false,
          user_id: 'anonymous_local',
          email: '',
          name: 'Guest User',
          subscription_tier: 'free',
          credit_balance: 0,
          avatar_url: ''
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Forward authenticated request to personalization backend if bearer token present
      try {
        const targetRes = await fetch('https://personalization.dondlingergc.com/api/auth/me', {
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
        });
        const data = await targetRes.json();
        return new Response(JSON.stringify(data), {
          status: targetRes.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({
          isAuthenticated: false,
          user_id: 'anonymous_local',
          name: 'Guest User',
          subscription_tier: 'free'
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
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
      const freeSearches = balance > 0 ? Math.floor(balance / 5) : 100;
      return new Response(JSON.stringify({
        userId,
        tier,
        isPro,
        searchesUsed: 0,
        searchesRemaining: isPro ? null : freeSearches,
        dailyLimit: isPro ? null : 100,
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

    // 3. Main Search Engine Route
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const { query, deepCrawl = true, mode = 'deep_reasoning', selectedAnswers = [] } = await request.json() as { query: string; deepCrawl?: boolean; mode?: string; selectedAnswers?: Array<{ question: string; answer: string }> };

        let searchResults: Array<{ title: string; url: string; snippet: string }> = [];
        let deepContentText = '';

        // Multi-Engine Web Search (DuckDuckGo + Wikipedia API)
        const getSearchResults = async (q: string) => {
          const results: Array<{ title: string; url: string; snippet: string }> = [];
          
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
          if (deepCrawl && searchResults.length > 0) {
            const crawlTargets = searchResults.slice(0, 3);
            const pageContents = await Promise.all(
              crawlTargets.map(async (target) => {
                try {
                  const controller = new AbortController();
                  const timeoutId = setTimeout(() => controller.abort(), 2000);
                  const res = await fetch(target.url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
                    signal: controller.signal
                  });
                  clearTimeout(timeoutId);
                  const html = await res.text();
                  const cleanText = html.replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
                                       .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
                                       .replace(/<[^>]+>/g, ' ')
                                       .replace(/\s+/g, ' ')
                                       .slice(0, 1500);
                  return `--- SOURCE: ${target.title} (${target.url}) ---\n${cleanText}`;
                } catch (e) {
                  return `--- SOURCE: ${target.title} (${target.url}) ---\n(Extracted from snippet: ${target.snippet})`;
                }
              })
            );
            deepContentText = pageContents.join('\n\n');
          }

          const selectedAnswersContext = selectedAnswers.length > 0
            ? `USER SELECTED RESEARCH DECISION BRANCHES:\n${selectedAnswers.map(a => `• Question: "${a.question}" -> User Choice: "${a.answer}"`).join('\n')}\n`
            : '';

          const fullPrompt = `USER OBJECTIVE: "${query}"
${selectedAnswersContext}
PRIMARY SEARCH SOURCES:
${searchResults.map(r => `• ${r.title} (${r.url}): ${r.snippet}`).join('\n')}

DEEP SCRAPED EXTRACTS:
${deepContentText}

INSTRUCTIONS:
You are InspectaLlama, a world-class Edge AI Research Engine. Synthesize an exhaustive, publication-grade markdown research report for "${query}".
In addition, generate 2 to 3 interactive /grill-me style decision nodes ("grillNodes") for step-by-step interview interrogation of this research topic. Each node must have a title, contextQuestion, and 2-3 distinct options (with one marked as isRecommended: true and a clear rationale).

Output ONLY valid JSON matching this schema:
{
  "executiveSummary": "# Research Synthesis: ${query}\\n\\nWrite an exhaustive markdown report with rich headers, detailed explanations, and technical depth.",
  "reasoningTrace": [{"step": 1, "description": "Information retrieval and claim verification"}],
  "claims": [{"statement": "Verified claim", "verbatimQuote": "Direct quote", "sourceTitle": "${searchResults[0]?.title || 'Source'}", "sourceUrl": "${searchResults[0]?.url || 'URL'}", "epistemicStatus": "Fact", "confidenceScore": 95}],
  "entities": [{"name": "${query}", "category": "Concept", "description": "Primary research objective"}],
  "disputes": [{"topic": "Key trade-off", "perspectiveA": "Advantage", "perspectiveB": "Limitation"}],
  "grillNodes": [
    {
      "stepIndex": 1,
      "title": "Decision Node 1",
      "contextQuestion": "Question about architectural or strategic choice for ${query}?",
      "options": [
        {"text": "(Recommended) Option A", "isRecommended": true, "rationale": "Why this is optimal."},
        {"text": "Option B", "isRecommended": false, "rationale": "Alternative perspective."}
      ]
    }
  ]
}`;

          let aiResponse: any = null;
          try {
            aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
              messages: [
                { role: 'system', content: 'Output strictly valid JSON with no markdown wrapping.' },
                { role: 'user', content: fullPrompt }
              ]
            });
          } catch (modelErr) {
            try {
              aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
                messages: [
                  { role: 'system', content: 'Output strictly valid JSON with no markdown wrapping.' },
                  { role: 'user', content: fullPrompt }
                ]
              });
            } catch (_) {
              aiResponse = { response: JSON.stringify({ executiveSummary: `Research results for "${query}":\n\n` + searchResults.map(s => `• ${s.title}: ${s.snippet}`).join('\n\n') }) };
            }
          }

          let parsedData: any = null;
          try {
            let str = aiResponse?.response || '';
            if (typeof str === 'object') str = JSON.stringify(str);
            const firstBrace = str.indexOf('{');
            const lastBrace = str.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) str = str.substring(firstBrace, lastBrace + 1);
            parsedData = JSON.parse(str);

            // Handle nested JSON string in executiveSummary if LLM outputs markdown json codeblocks
            if (typeof parsedData.executiveSummary === 'string' && parsedData.executiveSummary.trim().startsWith('```json')) {
              let innerStr = parsedData.executiveSummary.trim();
              innerStr = innerStr.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
              try {
                const innerObj = JSON.parse(innerStr);
                if (innerObj.executiveSummary) parsedData = innerObj;
              } catch (_) {}
            }
          } catch (_) {
            parsedData = {
              executiveSummary: typeof aiResponse?.response === 'string' ? aiResponse.response : 'Synthesis completed.',
              reasoningTrace: [{ step: 1, description: "Standard cognitive reasoning completed." }],
              claims: [],
              entities: [],
              disputes: []
            };
          }

          return new Response(JSON.stringify({
            query,
            mode: 'deep_reasoning',
            synthesis: parsedData.executiveSummary || parsedData.synthesis || 'Synthesis complete.',
            reasoningTrace: Array.isArray(parsedData.reasoningTrace) ? parsedData.reasoningTrace : [{ step: 1, description: "Cognitive reasoning completed." }],
            claims: Array.isArray(parsedData.claims) ? parsedData.claims : [],
            entities: Array.isArray(parsedData.entities) ? parsedData.entities : [],
            disputes: Array.isArray(parsedData.disputes) ? parsedData.disputes : [],
            grillNodes: Array.isArray(parsedData.grillNodes) ? parsedData.grillNodes : [],
            sources: searchResults,
            timestamp: new Date().toISOString()
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        } else {
          const contextText = searchResults.map(r => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n');
          const fullPrompt = `User Query: "${query}"\n\nSearch Snippets:\n${contextText}`;

          let aiResponse: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'You are InspectaLlama, an elite AI search engine. Synthesize a complete, structured response.' },
              { role: 'user', content: fullPrompt }
            ]
          });

          return new Response(JSON.stringify({
            query,
            mode: 'standard',
            synthesis: aiResponse?.response || 'Synthesis completed.',
            reasoningTrace: [],
            claims: [],
            entities: [],
            disputes: [],
            sources: searchResults,
            timestamp: new Date().toISOString()
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || 'Search execution failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // 4. Direct Evaluation Endpoint
    if (url.pathname === '/api/eval' && request.method === 'POST') {
      try {
        const { targetUrl } = await request.json() as { targetUrl: string };
        const pageRes = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await pageRes.text();
        const textContent = html.replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').slice(0, 3000);

        const aiRes = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: 'Analyze the target web content and synthesize a short evaluation.' },
            { role: 'user', content: `URL: ${targetUrl}\nContent:\n${textContent}` }
          ]
        });

        return new Response(JSON.stringify({
          success: true,
          targetUrl,
          evaluation: aiRes.response || 'Evaluation completed.',
          timestamp: new Date().toISOString()
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // 5. Visual Sequential Thinking / Forking Edge Router
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

    // 6. Interactive Grill-Me Interview Pipeline Endpoint
    if (url.pathname === '/api/grillme' && request.method === 'POST') {
      try {
        const { topic } = await request.json() as { topic: string };
        const grillPrompt = `TOPIC: "${topic}"
INSTRUCTIONS: You are the InspectaLlama Grill-Me Edge Dispatcher. Generate an interactive 3-step decision interview pipeline to clarify the scope, analytical perspective, depth, and output format for this specific research topic.
CRITICAL INVARIANT: Adapt your questions to the exact domain of the topic! If the topic is a person/biography/politics/history/science/news, DO NOT ask about software architecture, ZLA, or databases. Ask questions relevant to that specific subject matter (e.g. historical era, political career, scientific rigor, perspective lens, focus areas).

For each of the 3 steps, generate:
- stepIndex (1, 2, or 3)
- title (short domain-appropriate header)
- contextQuestion (clear question asking the user for their research preference regarding "${topic}")
- options: Array of 4 distinct options tailored specifically to "${topic}". Exactly ONE option must be marked with isRecommended: true and have a clear rationale.

Output ONLY valid JSON matching this schema:
{
  "questions": [
    {
      "stepIndex": 1,
      "title": "Domain Focus & Scope",
      "contextQuestion": "What specific angle or era should be prioritized for research on ${topic}?",
      "options": [
        {"text": "(Recommended) Comprehensive Historical & Fact-Checked Overview", "isRecommended": true, "rationale": "Sweeps official records, key milestones, and verified timeline."},
        {"text": "Recent Developments & Current Context", "isRecommended": false, "rationale": "Focuses strictly on recent events and emerging coverage."},
        {"text": "Key Controversies & Dialectical Perspectives", "isRecommended": false, "rationale": "Audits opposing viewpoints and claims for objective evaluation."},
        {"text": "Primary Document & Quote Analysis", "isRecommended": false, "rationale": "Prioritizes verbatim transcripts and primary source records."}
      ]
    }
  ]
}`;

        let aiRes: any = null;
        try {
          aiRes = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'Output strictly valid JSON with no markdown wrapping.' },
              { role: 'user', content: grillPrompt }
            ]
          });
        } catch (_) {
          aiRes = { response: '' };
        }

        let questions: any[] = [];
        try {
          let str = aiRes.response || '';
          const firstBrace = str.indexOf('{');
          const lastBrace = str.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1) {
            str = str.substring(firstBrace, lastBrace + 1);
            const parsed = JSON.parse(str);
            if (Array.isArray(parsed.questions)) questions = parsed.questions;
          }
        } catch (_) {}

        if (questions.length === 0) {
          const isTech = /code|software|api|wasm|zla|architecture|cloudflare|database|build|c#/i.test(topic);
          if (isTech) {
            questions = [
              {
                stepIndex: 1,
                title: "Technical Architecture Scope",
                contextQuestion: `What scope of engineering analysis should be conducted for "${topic}"?`,
                options: [
                  { text: "(Recommended) Zero-Liability Architecture (ZLA)", isRecommended: true, rationale: "100% client-side WASM execution with zero server liability." },
                  { text: "Cloudflare Durable Objects & WebSockets", isRecommended: false, rationale: "Real-time edge state persistence and live WebSocket broadcast." },
                  { text: "Stateless Edge Worker Routing", isRecommended: false, rationale: "High-performance edge routing with D1 database caching." },
                  { text: "Pure Offline WASM Isolation", isRecommended: false, rationale: "Client-side execution without external network calls." }
                ]
              },
              {
                stepIndex: 2,
                title: "Code & Benchmark Rigor",
                contextQuestion: "Which technical evaluation metric should be prioritized?",
                options: [
                  { text: "(Recommended) High Rigor (95%+ Confidence)", isRecommended: true, rationale: "Verifies technical specs against official documentation & benchmark logs." },
                  { text: "Exploratory Architecture Audit", isRecommended: false, rationale: "Broad survey of competing framework implementations." },
                  { text: "Security & Vulnerability Audit", isRecommended: false, rationale: "Analyzes attack vectors and data isolation boundaries." },
                  { text: "Performance & Cold-Start Benchmark", isRecommended: false, rationale: "Focuses on execution latency and resource memory usage." }
                ]
              },
              {
                stepIndex: 3,
                title: "Output Spec Format",
                contextQuestion: "How should the technical findings be formatted?",
                options: [
                  { text: "(Recommended) Publication-Grade Markdown & Code Samples", isRecommended: true, rationale: "Full architectural breakdown with runnable code blocks." },
                  { text: "Executive Architecture Briefing", isRecommended: false, rationale: "High-level summary for engineering leadership." },
                  { text: "Step-by-Step Migration Blueprint", isRecommended: false, rationale: "Actionable refactoring roadmap." },
                  { text: "Interactive Decision Tree", isRecommended: false, rationale: "Categorized tradeoff matrix." }
                ]
              }
            ];
          } else {
            questions = [
              {
                stepIndex: 1,
                title: "Research Focus & Scope",
                contextQuestion: `Which primary perspective or era should be examined for "${topic}"?`,
                options: [
                  { text: "(Recommended) Comprehensive Historical & Fact-Checked Overview", isRecommended: true, rationale: "Examines official records, key milestones, and verified timeline." },
                  { text: "Recent News & Contemporary Developments", isRecommended: false, rationale: "Focuses strictly on recent events and emerging coverage." },
                  { text: "Dialectical Viewpoints & Critical Debates", isRecommended: false, rationale: "Audits opposing perspectives and contested claims for objective balance." },
                  { text: "Key Quotes & Verbatim Statements", isRecommended: false, rationale: "Prioritizes primary source quotes and direct public statements." }
                ]
              },
              {
                stepIndex: 2,
                title: "Epistemic Rigor & Source Selection",
                contextQuestion: "What verification standard should govern the source audit?",
                options: [
                  { text: "(Recommended) High Rigor (95%+ Epistemic Confidence)", isRecommended: true, rationale: "Cross-references multiple independent primary sources and encyclopedia archives." },
                  { text: "Broad Exploratory Survey", isRecommended: false, rationale: "Captures emerging media coverage and public discourse." },
                  { text: "Strict Primary Source Verification", isRecommended: rationale: false, "Filters out commentary, requiring official documents or direct quotes." },
                  { text: "Rapid Fact Sweep", isRecommended: false, rationale: "Fast consensus summary of established facts." }
                ]
              },
              {
                stepIndex: 3,
                title: "Report Structure",
                contextQuestion: "How should the research report be structured?",
                options: [
                  { text: "(Recommended) Verified Claims Matrix & Source Audits", isRecommended: true, rationale: "Dialectical report with claim confidence badges and verbatim quotes." },
                  { text: "Chronological Timeline & Key Milestones", isRecommended: false, rationale: "Sequential breakdown of historical events." },
                  { text: "Executive Summary & Key Takeaways", isRecommended: false, rationale: "High-level briefing for fast reading." },
                  { text: "Deep Analytical Monograph", isRecommended: false, rationale: "In-depth investigation with full context." }
                ]
              }
            ];
          }
        }

        return new Response(JSON.stringify({ success: true, topic, questions }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Fallback to static asset serving with WASM immutable caching
    const response = env.ASSETS ? await env.ASSETS.fetch(request) : new Response('InspectaLlama Edge Router Active', { status: 200 });
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
    
    // Strict Anti-Caching for ALL static assets to guarantee instant edge propagation
    newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    newHeaders.set('Pragma', 'no-cache');
    newHeaders.set('Expires', '0');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};
