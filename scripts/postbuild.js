const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist', 'wwwroot', '_framework');
if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    const blazorFile = files.find(f => f.startsWith('blazor.webassembly.') && f.endsWith('.js'));
    if (blazorFile) {
        fs.copyFileSync(path.join(dir, blazorFile), path.join(dir, 'blazor.webassembly.js'));
        console.log(`Copied ${blazorFile} -> blazor.webassembly.js`);
    }
}
