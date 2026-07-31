const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist', 'wwwroot', '_framework');
if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    
    // Map of prefix patterns to unfingerprinted filenames
    const targets = [
        { prefix: 'blazor.webassembly.', ext: '.js', target: 'blazor.webassembly.js' },
        { prefix: 'dotnet.', ext: '.js', target: 'dotnet.js', excludePrefix: ['dotnet.native.', 'dotnet.runtime.'] },
        { prefix: 'dotnet.native.', ext: '.wasm', target: 'dotnet.native.wasm' },
        { prefix: 'dotnet.native.', ext: '.js', target: 'dotnet.native.js' },
        { prefix: 'dotnet.runtime.', ext: '.js', target: 'dotnet.runtime.js' },
        { prefix: 'InspectaLlamaDO.', ext: '.wasm', target: 'InspectaLlamaDO.wasm' }
    ];

    for (const t of targets) {
        const matches = files.filter(f => {
            if (!f.startsWith(t.prefix) || !f.endsWith(t.ext)) return false;
            if (t.excludePrefix && t.excludePrefix.some(p => f.startsWith(p))) return false;
            if (f === t.target) return false;
            if (f.endsWith('.br') || f.endsWith('.gz')) return false;
            return true;
        }).sort((a, b) => {
            const statA = fs.statSync(path.join(dir, a));
            const statB = fs.statSync(path.join(dir, b));
            return statB.mtimeMs - statA.mtimeMs;
        });

        const found = matches[0];

        if (found) {
            const srcPath = path.join(dir, found);
            const dstPath = path.join(dir, t.target);
            fs.copyFileSync(srcPath, dstPath);
            console.log(`[POSTBUILD FIX] Copied NEWEST ${found} (${fs.statSync(srcPath).size} bytes) -> ${t.target}`);

            // Also copy compressed .br and .gz variants if present
            for (const ext of ['.br', '.gz']) {
                if (fs.existsSync(srcPath + ext)) {
                    fs.copyFileSync(srcPath + ext, dstPath + ext);
                    console.log(`[POSTBUILD FIX] Copied ${found}${ext} -> ${t.target}${ext}`);
                }
            }
        }
    }
}

