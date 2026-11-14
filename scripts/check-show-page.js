const fs = require('fs');
const html = fs.readFileSync('C:\\Users\\haren\\Downloads\\Photon AI\\admin.html', 'utf8');

const spIdx = html.indexOf('function showPage()');
console.log('function showPage():');
if (spIdx !== -1) {
  console.log(html.substring(spIdx, spIdx + 800));
} else {
  const sp2 = html.indexOf('showPage');
  console.log(html.substring(sp2 - 100, sp2 + 800));
}
