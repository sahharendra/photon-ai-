const fs = require('fs');

const adminPath = 'C:\\Users\\haren\\Downloads\\Photon AI\\admin.html';
let html = fs.readFileSync(adminPath, 'utf8');

// 1. Update renderUsersKpis to populate aggregate banner and KPIs
const oldRenderUsersKpis = `function renderUsersKpis(kpis,timeoutMs){
  const k=kpis||{};
  $('kpi-reg').textContent=fmt(k.totalRegisteredUsers);
  $('kpi-logged-today').textContent=fmt(k.loggedInToday);
  $('kpi-online').textContent=fmt(k.currentlyOnlineUsers);
  $('kpi-signins').textContent=fmt(k.totalSignIns);
  $('kpi-tokens').textContent=fmt(k.totalTokensUsed);
  $('kpi-paid').textContent=fmt(k.activePaidSubscribers);
  $('kpi-free').textContent=fmt(k.freePlanUsers);
  if(timeoutMs)$('kpi-online-note').textContent='Active '+Math.round(timeoutMs/60000)+'m heartbeat';
 }`;

const newRenderUsersKpis = `function renderUsersKpis(kpis,timeoutMs){
  const k=kpis||{};
  if($('kpi-reg'))$('kpi-reg').textContent=fmt(k.totalRegisteredUsers);
  if($('kpi-logged-today'))$('kpi-logged-today').textContent=fmt(k.loggedInToday);
  if($('kpi-online'))$('kpi-online').textContent=fmt(k.currentlyOnlineUsers);
  if($('kpi-signins'))$('kpi-signins').textContent=fmt(k.totalSignIns);
  if($('kpi-tokens'))$('kpi-tokens').textContent=fmt(k.totalTokensUsed);
  if($('kpi-paid'))$('kpi-paid').textContent=fmt(k.activePaidSubscribers);
  if($('kpi-free'))$('kpi-free').textContent=fmt(k.freePlanUsers);
  if(timeoutMs&&$('kpi-online-note'))$('kpi-online-note').textContent='Active '+Math.round(timeoutMs/60000)+'m heartbeat';

  const allowance = Number(k.totalDailyAllowance||0);
  const used = Number(k.totalTokensToday||0);
  const remaining = k.remainingTokens!=null ? k.remainingTokens : Math.max(0, allowance - used);
  const pct = k.percentUtilized!=null ? k.percentUtilized : (allowance>0 ? Math.round((used/allowance)*100) : 0);
  if($('users-agg-allowance')) $('users-agg-allowance').textContent = fmt(allowance);
  if($('users-agg-used')) $('users-agg-used').textContent = fmt(used);
  if($('users-agg-remaining')) $('users-agg-remaining').textContent = fmt(remaining);
  if($('users-agg-pct')) $('users-agg-pct').textContent = pct + '%';
 }`;

if (html.includes(oldRenderUsersKpis)) {
  html = html.replace(oldRenderUsersKpis, newRenderUsersKpis);
  console.log('Replaced renderUsersKpis successfully.');
} else {
  console.error('Could not find old renderUsersKpis!');
}

// 2. Add renderDashboard and setupDashboardAnalyticsFilter
const dashboardFunctions = `
function renderDashboard(data){
  if(!data)return;
  const m=data.metrics||{};
  const k=data.kpis||{};
  if($('dash-total-users'))$('dash-total-users').textContent=fmt(m.totalRegisteredUsers||m.totalUsers||k.totalRegisteredUsers||0);
  if($('dash-login-today'))$('dash-login-today').textContent=fmt(m.loggedInToday||k.loggedInToday||0);
  if($('dash-online-users'))$('dash-online-users').textContent=fmt(m.currentlyOnlineUsers||m.onlineUsers||k.currentlyOnlineUsers||0);
  if($('dash-paid-users'))$('dash-paid-users').textContent=fmt(m.activePaidSubscribers||m.paidSubscribers||k.activePaidSubscribers||0);
  if($('dash-free-users'))$('dash-free-users').textContent=fmt(m.freePlanUsers||m.freeUsers||k.freePlanUsers||0);
  if($('dash-tokens-today'))$('dash-tokens-today').textContent=fmt(m.totalTokensToday||m.tokensToday||k.totalTokensToday||0);

  // Daily Token Usage
  const allowance = Number(m.totalDailyAllowance||k.totalDailyAllowance||0);
  const consumed = Number(m.totalTokensToday||m.tokensToday||k.totalTokensToday||0);
  const remaining = Math.max(0, allowance - consumed);
  const pct = allowance > 0 ? Math.min(100, Math.round((consumed / allowance) * 100)) : 0;
  if($('dash-token-headline'))$('dash-token-headline').textContent=fmt(consumed)+' / '+fmt(allowance)+' Tokens Used Today';
  if($('dash-token-allowance'))$('dash-token-allowance').textContent=fmt(allowance);
  if($('dash-token-consumed'))$('dash-token-consumed').textContent=fmt(consumed);
  if($('dash-token-remaining'))$('dash-token-remaining').textContent=fmt(remaining);
  if($('dash-token-pct'))$('dash-token-pct').textContent=pct+'%';
  if($('dash-token-bar'))$('dash-token-bar').style.width=Math.max(consumed>0?2:0, pct)+'%';

  // Analytics
  const an=data.analytics;
  if(an){
    const inR=an.inRange||{};
    if($('dash-range-reg'))$('dash-range-reg').textContent=fmt(inR.registrations||0);
    if($('dash-range-signins'))$('dash-range-signins').textContent=fmt(inR.signIns||0);
    if($('dash-range-tokens'))$('dash-range-tokens').textContent=fmt(inR.tokensUsed||0);
    if($('dash-range-rev'))$('dash-range-rev').textContent='₹'+fmt(inR.revenue||0);
    if($('dash-range-purchases'))$('dash-range-purchases').textContent=fmt(inR.purchases||0);

    const renderTrendRows=(id, list, valKey, prefix='')=>{
      const el=$(id);if(!el)return;
      el.replaceChildren();
      if(!list||!list.length){el.innerHTML='<div class="muted" style="padding:8px 0;">No activity in this period.</div>';return}
      const tbl=document.createElement('table');tbl.style.width='100%';tbl.style.borderCollapse='collapse';
      list.slice(-10).reverse().forEach(row=>{
        const tr=document.createElement('tr');tr.style.borderBottom='1px solid rgba(255,255,255,0.05)';
        const td1=document.createElement('td');td1.style.padding='4px 0';td1.style.color='var(--muted)';td1.textContent=row.date;
        const td2=document.createElement('td');td2.style.padding='4px 0';td2.style.textAlign='right';td2.style.fontWeight='600';td2.textContent=prefix+fmt(row[valKey]);
        tr.append(td1,td2);tbl.appendChild(tr);
      });
      el.appendChild(tbl);
    };

    renderTrendRows('dash-trend-signins', an.trends?.signIns, 'count');
    renderTrendRows('dash-trend-tokens', an.trends?.tokenUsage, 'tokens');
    renderTrendRows('dash-trend-reg', an.trends?.registrations, 'count');
    renderTrendRows('dash-trend-rev', an.trends?.revenue, 'amount', '₹');
  }
}

function setupDashboardAnalyticsFilter(){
  const sel=$('dash-date-range');
  const customSpan=$('dash-custom-dates');
  const btn=$('dash-filter-btn');
  if(!sel||sel.dataset.bound)return;
  sel.dataset.bound='1';
  sel.addEventListener('change',()=>{
    if(sel.value==='custom'){
      customSpan.style.display='inline-flex';
    }else{
      customSpan.style.display='none';
      applyDashFilter();
    }
  });
  if(btn){
    btn.addEventListener('click',applyDashFilter);
  }
  async function applyDashFilter(){
    const range=sel.value;
    let url='/api/admin/overview?range='+encodeURIComponent(range);
    if(range==='custom'){
      const from=$('dash-date-from')?.value;
      const to=$('dash-date-to')?.value;
      if(from)url+='&from='+encodeURIComponent(from);
      if(to)url+='&to='+encodeURIComponent(to);
    }
    try{
      const data=await request(url);
      renderDashboard(data);
    }catch(err){
      status(err.message||'Could not filter dashboard.',true);
    }
  }
}
`;

// Insert dashboardFunctions right before function load(
const loadAnchor = 'async function load(forceSettings=false){';
if (html.includes(loadAnchor)) {
  html = html.replace(loadAnchor, dashboardFunctions + '\n' + loadAnchor);
  console.log('Added renderDashboard and setup functions.');
} else {
  console.error('Could not find loadAnchor!');
}

// Call renderDashboard(data) and setupDashboardAnalyticsFilter() in load()
const loadCallOld = "$('tokens').textContent=fmt(m.tokensToday);";
const loadCallNew = "$('tokens').textContent=fmt(m.tokensToday);renderDashboard(data);setupDashboardAnalyticsFilter();";
if (html.includes(loadCallOld)) {
  html = html.replace(loadCallOld, loadCallNew);
  console.log('Added renderDashboard call to load().');
}

fs.writeFileSync(adminPath, html, 'utf8');
console.log('Saved admin.html dashboard JS updates.');
