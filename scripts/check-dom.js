const fs = require('fs');
const html = fs.readFileSync('C:/Users/haren/Downloads/Photon AI/admin.html', 'utf8');

const sIdx = html.indexOf('async function load(');
console.log(html.slice(sIdx, sIdx + 1600));
