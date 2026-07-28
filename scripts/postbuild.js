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
        const found = files.find(f => {
            if (!f.startsWith(t.prefix) || !f.endsWith(t.ext)) return false;
            if (t.excludePrefix && t.excludePrefix.some(p => f.startsWith(p))) return false;
            // Ensure it's not already the un-fingerprinted target file name
            if (f === t.target) return false;
            return true;
        });

        if (found) {
            const srcPath = path.join(dir, found);
            const dstPath = path.join(dir, t.target);
            fs.copyFileSync(srcPath, dstPath);
            console.log(`Copied ${found} -> ${t.target}`);

            // Also copy compressed .br and .gz variants if present
            for (const ext of ['.br', '.gz']) {
                if (fs.existsSync(srcPath + ext)) {
                    fs.copyFileSync(srcPath + ext, dstPath + ext);
                    console.log(`Copied ${found}${ext} -> ${t.target}${ext}`);
                }
            }
        }
    }
}
