const fs = require('fs');

const html = fs.readFileSync('C:\\Users\\haren\\Downloads\\Photon AI\\admin.html', 'utf8');

console.log('=== INVESTIGATING ADMIN NAVIGATION & STRUCTURE ===\n');

// 1. Sidebar Nav
const navIdx = html.indexOf('<nav class="nav">');
if (navIdx !== -1) {
  console.log('--- Sidebar Nav ---');
  console.log(html.substring(navIdx, navIdx + 600));
}

// 2. Page View Sections
const pageViewRegex = /<[^>]+class=["'][^"']*page-view[^"']*["'][^>]*>/g;
let match;
console.log('\n--- Page View Elements in HTML ---');
while ((match = pageViewRegex.exec(html)) !== null) {
  console.log(match[0]);
}

// 3. Routing logic / hashchange
const routeIdx = html.indexOf('hashchange');
console.log('\n--- hashchange / route logic ---');
if (routeIdx !== -1) {
  console.log(html.substring(routeIdx - 200, routeIdx + 800));
} else {
  console.log('No hashchange found!');
}

// 4. Page metadata / titles
const metaIdx = html.indexOf('pageMeta');
console.log('\n--- pageMeta ---');
if (metaIdx !== -1) {
  console.log(html.substring(metaIdx - 50, metaIdx + 400));
}

// 5. Check CSS for .page-view
const pvCssIdx = html.indexOf('.page-view');
console.log('\n--- .page-view CSS ---');
if (pvCssIdx !== -1) {
  console.log(html.substring(pvCssIdx - 50, pvCssIdx + 400));
}
