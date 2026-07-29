window.zlaInterop = {
    // Scene 3: Draw Wireframe Jig
    drawWireframeJig: function (elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;
        
        // SVG wireframe animation logic
        el.innerHTML = `
            <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
                <path d="M10,90 L50,10 L90,90 Z" fill="none" stroke="#00f0ff" stroke-width="2" stroke-dasharray="300" stroke-dashoffset="300">
                    <animate attributeName="stroke-dashoffset" from="300" to="0" dur="2s" fill="freeze" />
                </path>
                <circle cx="50" cy="50" r="20" fill="none" stroke="#39ff14" stroke-width="1" stroke-dasharray="150" stroke-dashoffset="150">
                    <animate attributeName="stroke-dashoffset" from="150" to="0" dur="1.5s" begin="0.5s" fill="freeze" />
                </circle>
            </svg>
        `;
    },

    // Scene 4: Slider/Drag Logic
    initPourSlider: function (dotNetHelper, elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;

        let isDragging = false;
        
        el.addEventListener('mousedown', (e) => {
            isDragging = true;
        });
        
        el.addEventListener('touchstart', (e) => {
            isDragging = true;
        }, { passive: true });

        window.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        window.addEventListener('touchend', () => {
            isDragging = false;
        });

        const updatePosition = (clientX) => {
            if (!isDragging) return;
            const rect = el.parentElement.getBoundingClientRect();
            let percentage = ((clientX - rect.left) / rect.width) * 100;
            percentage = Math.max(0, Math.min(100, percentage));
            el.style.left = percentage + '%';
            
            // Call back to Blazor
            if (dotNetHelper) {
                dotNetHelper.invokeMethodAsync('UpdatePourState', percentage);
            }
        };

        window.addEventListener('mousemove', (e) => {
            updatePosition(e.clientX);
        });
        
        window.addEventListener('touchmove', (e) => {
            if (e.touches.length > 0) {
                updatePosition(e.touches[0].clientX);
            }
        }, { passive: true });
    },

    // Scene 5: Celebration
    triggerConfetti: function (elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;

        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '9999';
        el.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        canvas.width = el.clientWidth;
        canvas.height = el.clientHeight;

        const particles = [];
        for (let i = 0; i < 150; i++) {
            particles.push({
                x: canvas.width / 2,
                y: canvas.height / 2,
                vx: (Math.random() - 0.5) * 15,
                vy: (Math.random() - 0.5) * 15 - 5,
                size: Math.random() * 6 + 4,
                color: Math.random() > 0.5 ? '#00f0ff' : (Math.random() > 0.5 ? '#39ff14' : '#ff0055')
            });
        }

        let animationFrame;
        function render() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.3; // gravity
                ctx.fillStyle = p.color;
                ctx.fillRect(p.x, p.y, p.size, p.size);
            });
            animationFrame = requestAnimationFrame(render);
        }
        render();

        setTimeout(() => {
            cancelAnimationFrame(animationFrame);
            if (canvas.parentNode) {
                canvas.parentNode.removeChild(canvas);
            }
        }, 4000);
    },

    // Scroll snapping helper
    scrollToElement: function (elementId) {
        const el = document.getElementById(elementId);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    },

    // ── Central Personalization SSO & Identity Interop ──
    checkPersonalizationSession: async function () {
        const jwt = localStorage.getItem('inspectallamado_jwt');
        const headers = { 'Accept': 'application/json' };
        if (jwt) {
            headers['Authorization'] = 'Bearer ' + jwt;
        }

        try {
            const response = await fetch('https://personalization.dondlingergc.com/api/auth/me', {
                method: 'GET',
                credentials: 'include',
                headers: headers
            });

            if (response.ok) {
                const data = await response.json();
                return JSON.stringify({
                    isAuthenticated: true,
                    userId: data.user_id || data.id || 'usr_personalization',
                    email: data.email || '',
                    name: data.name || data.display_name || 'Dondlinger User',
                    subscriptionTier: data.subscription_tier || data.tier || 'free',
                    creditBalance: data.credit_balance ?? data.credits ?? 0,
                    avatarUrl: data.avatar_url || ''
                });
            }
        } catch (e) {
            console.warn('[ZLA SSO] Personalization endpoint offline or unauthenticated fallback:', e);
        }

        // Offline / Unauthenticated ZLA Fallback
        return JSON.stringify({
            isAuthenticated: false,
            userId: 'anonymous_local',
            email: '',
            name: 'Guest User',
            subscriptionTier: 'free',
            creditBalance: 0,
            avatarUrl: ''
        });
    },

    getJwtToken: function () {
        return localStorage.getItem('inspectallamado_jwt') || '';
    },

    setJwtToken: function (token) {
        if (token) {
            localStorage.setItem('inspectallamado_jwt', token);
        } else {
            localStorage.removeItem('inspectallamado_jwt');
        }
    },

    syncSettingsToPersonalization: async function (settingsJson) {
        const jwt = localStorage.getItem('inspectallamado_jwt');
        const headers = { 'Content-Type': 'application/json' };
        if (jwt) headers['Authorization'] = 'Bearer ' + jwt;

        try {
            const res = await fetch('https://personalization.dondlingergc.com/api/settings', {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: settingsJson
            });
            return res.ok;
        } catch (e) {
            console.error('[ZLA Sync] Sync error:', e);
            return false;
        }
    },

    downloadFile: function (filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    generateExecutivePdf: function (reportDataJson) {
        let data = {};
        try {
            data = typeof reportDataJson === 'string' ? JSON.parse(reportDataJson) : reportDataJson;
        } catch (e) {
            console.error('Invalid PDF report payload', e);
            return;
        }

        const printWin = window.open('', '_blank');
        if (!printWin) {
            alert('Please allow popups to view and print your Executive PDF Report.');
            return;
        }

        const claimsHtml = (data.claims || []).map(c => `
            <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px; font-weight: 600;">${c.statement}</td>
                <td style="padding: 10px; font-style: italic; color: #475569; background: #f8fafc;">"${c.verbatimQuote || 'N/A'}"</td>
                <td style="padding: 10px;"><a href="${c.sourceUrl}" target="_blank" style="color: #2563eb; text-decoration: none;">${c.sourceTitle || 'Source'}</a></td>
                <td style="padding: 10px;"><span style="padding: 4px 8px; border-radius: 9999px; font-size: 11px; font-weight: 700; background: ${c.epistemicStatus === 'Fact' ? '#dcfce7; color: #15803d;' : (c.epistemicStatus === 'Disputed' ? '#fee2e2; color: #b91c1c;' : '#fef3c7; color: #b45309;')}">${c.epistemicStatus || 'Fact'}</span></td>
                <td style="padding: 10px; font-weight: 700; color: #0f172a;">${c.confidenceScore}%</td>
            </tr>
        `).join('');

        const disputesHtml = (data.disputes || []).map(d => `
            <div style="margin-bottom: 15px; padding: 15px; background: #f8fafc; border-left: 4px solid #3b82f6; border-radius: 6px;">
                <h4 style="margin: 0 0 8px 0; color: #1e293b;">⚡ ${d.topic}</h4>
                <div style="display: flex; gap: 20px; font-size: 13px;">
                    <div style="flex: 1;"><strong style="color: #166534;">Perspective A:</strong> ${d.perspectiveA}</div>
                    <div style="flex: 1;"><strong style="color: #991b1b;">Perspective B:</strong> ${d.perspectiveB}</div>
                </div>
            </div>
        `).join('');

        const sourcesHtml = (data.sources || []).map(s => `
            <li style="margin-bottom: 8px;"><a href="${s.url}" target="_blank" style="color: #2563eb; font-weight: 600;">${s.title}</a> - <span style="color: #64748b;">${s.snippet}</span></li>
        `).join('');

        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>InspectaLlama Executive Report - ${data.query}</title>
                <style>
                    @page { size: A4; margin: 20mm; }
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.6; margin: 0; padding: 0; }
                    .header { border-bottom: 3px solid #3b82f6; padding-bottom: 15px; margin-bottom: 25px; display: flex; justify-content: space-between; align-items: flex-end; }
                    .header h1 { font-size: 24px; font-weight: 900; margin: 0; color: #1e3a8a; }
                    .header .meta { font-size: 12px; color: #64748b; text-align: right; }
                    .badge { background: #eff6ff; color: #1d4ed8; padding: 3px 10px; border-radius: 9999px; font-weight: 700; font-size: 11px; text-transform: uppercase; }
                    h2 { font-size: 18px; font-weight: 800; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin-top: 30px; color: #1e293b; }
                    .summary { background: #f8fafc; border: 1px solid #e2e8f0; padding: 18px; border-radius: 8px; font-size: 14px; margin-bottom: 25px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12px; }
                    th { background: #f1f5f9; text-align: left; padding: 10px; font-weight: 700; color: #334155; border-bottom: 2px solid #cbd5e1; }
                    .footer { margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 15px; font-size: 11px; color: #94a3b8; text-align: center; }
                    @media print {
                        .no-print { display: none; }
                    }
                </style>
            </head>
            <body>
                <div class="no-print" style="background: #3b82f6; color: white; padding: 12px 20px; text-align: center; font-weight: bold; position: sticky; top: 0;">
                    📄 InspectaLlama Executive Report Preview &nbsp;|&nbsp;
                    <button onclick="window.print()" style="background: white; color: #2563eb; border: none; font-weight: bold; padding: 6px 16px; border-radius: 6px; cursor: pointer; margin-left: 10px;">
                        🖨️ Print / Save as PDF
                    </button>
                </div>
                <div style="padding: 20px;">
                    <div class="header">
                        <div>
                            <span class="badge">InspectaLlama Deep Cognitive Intelligence</span>
                            <h1 style="margin-top: 5px;">Executive Research Brief</h1>
                            <div style="font-size: 15px; font-weight: 600; color: #475569; margin-top: 4px;">Target: "${data.query}"</div>
                        </div>
                        <div class="meta">
                            <div><strong>Date:</strong> ${data.timestamp ? new Date(data.timestamp).toLocaleString() : new Date().toLocaleDateString()}</div>
                            <div><strong>Verified by:</strong> Cloudflare Edge Browser &amp; Llama 3.3 70B</div>
                        </div>
                    </div>

                    <h2>Executive Overview &amp; Synthesis</h2>
                    <div class="summary">
                        ${(data.synthesis || '').replace(/\n/g, '<br/>')}
                    </div>

                    ${claimsHtml ? `
                    <h2>Verified Claim &amp; Epistemic Matrix</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Claim Statement</th>
                                <th>Verbatim Source Quote</th>
                                <th>Source</th>
                                <th>Status</th>
                                <th>Confidence</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${claimsHtml}
                        </tbody>
                    </table>
                    ` : ''}

                    ${disputesHtml ? `
                    <h2>Dialectical Trade-off &amp; Dispute Breakdown</h2>
                    ${disputesHtml}
                    ` : ''}

                    ${sourcesHtml ? `
                    <h2>Audited Source Citations</h2>
                    <ul style="padding-left: 20px; font-size: 13px;">
                        ${sourcesHtml}
                    </ul>
                    ` : ''}

                    ${data.screenshotBase64 ? `
                    <h2>Primary Inspected Web Screenshot</h2>
                    <div style="border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; margin-top: 15px;">
                        <img src="data:image/jpeg;base64,${data.screenshotBase64}" style="width: 100%; height: auto; display: block;" />
                    </div>
                    ` : ''}

                    <div class="footer">
                        Generated by InspectaLlama DO Platform &bull; inspectallamado.dondlingergc.com &bull; Confidential Research Intelligence
                    </div>
                </div>
            </body>
            </html>
        `;

        printWin.document.open();
        printWin.document.write(htmlContent);
        printWin.document.close();
    }
};

