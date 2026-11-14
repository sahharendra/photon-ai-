const fs = require('fs');
const html = fs.readFileSync('C:\\Users\\haren\\Downloads\\Photon AI\\admin.html', 'utf8');

const sIdx = html.indexOf('<aside');
console.log('Sidebar markup:');
console.log(html.substring(sIdx, sIdx + 800));
