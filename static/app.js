const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
let currentData = { tasks: [], learnings: [], outputs: [], experiences: [] };
let autoSaveTimer = null;
let editingDate = null;
let currentReportYear = null, currentReportWeek = null;
let settings = { companies: [] };

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  updateHeaderDate(); loadToday(); loadSettings(); loadRefs();
  document.getElementById('view-today').addEventListener('input', debounceAutoSave);
  document.getElementById('view-today').addEventListener('change', debounceAutoSave);
  document.getElementById('view-today').addEventListener('blur', autoSave, true);  // 焦点离开时保存
  // 多种时机保存，确保数据不丢
  function forceSave() {
    if (editingDate) return;
    const payload = JSON.stringify({ date: TODAY, tasks: currentData.tasks, learnings: currentData.learnings, outputs: currentData.outputs, experiences: currentData.experiences });
    fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
  }
  window.addEventListener('beforeunload', forceSave);
  window.addEventListener('pagehide', forceSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) forceSave(); });
  // 恢复上次的 Tab
  const lastView = localStorage.getItem('lastView');
  if (lastView && (lastView === 'history' || lastView === 'report')) {
    switchView(lastView);
  }
  // 粘贴图片自动上传
  document.body.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = async () => {
          const b64 = reader.result;
          try {
            const res = await api('/api/upload', 'POST', {data: b64});
            if (res && res.ok) {
              const url = res.url;
              // 插入到当前聚焦的 contenteditable 元素
              const sel = window.getSelection();
              if (sel.rangeCount && sel.focusNode) {
                const editable = sel.focusNode.closest?.('[contenteditable]') || sel.focusNode.parentElement?.closest?.('[contenteditable]');
                if (editable) {
                  const img = document.createElement('img');
                  img.src = url;
                  img.style.maxWidth = '100%';
                  img.style.borderRadius = '6px';
                  img.style.margin = '4px 0';
                  const range = sel.getRangeAt(0);
                  range.deleteContents();
                  range.insertNode(img);
                  range.collapse(false);
                  // Trigger input to save
                  editable.dispatchEvent(new Event('input', {bubbles:true}));
                }
              }
              showToast('图片已粘贴');
            }
          } catch(err) { showToast('上传失败'); }
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  });

  // 任意图片点击放大（事件委托）
  document.body.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG') {
      const src = e.target.src;
      if (src) { e.stopPropagation(); openLightbox(src); }
    }
  });
});

function updateHeaderDate() {
  const now = new Date(); const wd = ['周日','周一','周二','周三','周四','周五','周六'];
  document.getElementById('headerDate').textContent = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${wd[now.getDay()]}`;
}
function switchView(view) {
  // 切走今日时立即保存
  if (!editingDate && !document.getElementById('view-today').classList.contains('active')) {
    autoSave();
  }
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`[data-view="${view}"]`).classList.add('active');
  localStorage.setItem('lastView', view);
  if (view === 'today') loadToday();  // 切回今日重新加载确保最新
  if (view === 'history') loadHistory();
  if (view === 'report') initReport();
}

// ============================================================
// API
// ============================================================
async function api(url, method='GET', body=null) {
  const opts = { method, headers: {'Content-Type':'application/json'} };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = '/'; return null; }
  const ct = res.headers.get('content-type')||'';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function logout(){
  await api('/api/auth/logout', 'POST');
  window.location.href = '/';
}

async function loadToday() {
  editingDate = null;
  const data = await api(`/api/record/${TODAY}`);
  if (data && !data.error) {
    currentData = normalize(data);
  } else {
    currentData = { tasks: [], learnings: [], outputs: [], experiences: [] };
  }
  renderAll('today');
}
function normalize(data) { return { tasks: data.tasks||[], learnings: data.learnings||[], outputs: data.outputs||[], experiences: data.experiences||[] }; }

// ============================================================
// Settings
// ============================================================
async function loadSettings() {
  try { const s = await api('/api/settings'); if (s) settings = s; } catch(e) {}
  if (!settings || !settings.companies) settings = { companies: [] };
  updateHeaderWeeks();
}

function updateHeaderWeeks() {
  const el = document.getElementById('headerWeeks');
  if (!el) return;
  const weeks = settings.current_weeks || [];
  if (weeks.length) {
    el.textContent = weeks.map(w => `${w.name}第${w.week_num}周`).join(' · ');
    el.style.display = 'inline';
  } else {
    el.style.display = 'none';
  }
}
async function saveSettingsData() {
  try {
    await api('/api/settings', 'POST', settings);
    showToast('设置已保存');
    // Update hint
    const hint = document.getElementById('settingsHint');
    if (hint) hint.style.display = 'none';
    closeSettings();
  } catch(e) { showToast('保存失败'); }
}

function openSettings() {
  document.getElementById('settingsBody').innerHTML = renderSettingsForm();
  document.getElementById('settingsOverlay').classList.add('show');
}
function closeSettings(event) {
  if (event && event.target !== document.getElementById('settingsOverlay')) return;
  document.getElementById('settingsOverlay').classList.remove('show');
  loadSettings(); // reload
}
function renderSettingsForm() {
  let h = '<div class="settings-section"><label>入职公司</label>';
  h += '<div id="companyTags" style="margin-bottom:8px;">';
  (settings.companies||[]).forEach((c, i) => {
    h += `<span class="company-tag">${esc(c.name)} · ${esc(c.start_date)} <span class="remove" onclick="removeCompany(${i})">×</span></span>`;
  });
  if (!(settings.companies||[]).length) h += '<span style="font-size:13px;color:var(--text-secondary);">暂无，请添加</span>';
  h += '</div>';
  h += '<div style="display:flex;gap:8px;margin-top:8px;">';
  h += '<input class="settings-input" placeholder="公司名称" id="newCompanyName" style="flex:1;">';
  h += '<input class="settings-input" type="date" id="newCompanyDate" style="flex:1;">';
  h += '</div>';
  h += '<button class="save-btn" style="margin-top:10px;" onclick="addCompany()">＋ 添加公司</button>';
  h += '</div>';
  h += '<button class="save-btn" onclick="saveSettingsData()">💾 保存设置</button>';
  return h;
}
function addCompany() {
  const name = document.getElementById('newCompanyName').value.trim();
  const date = document.getElementById('newCompanyDate').value;
  if (!name || !date) { showToast('请填写公司名称和入职日期'); return; }
  if (!settings.companies) settings.companies = [];
  // 去重
  if (settings.companies.some(c => c.name === name && c.start_date === date)) { showToast('已存在相同记录'); return; }
  settings.companies.push({ name, start_date: date });
  document.getElementById('settingsBody').innerHTML = renderSettingsForm();
}
function removeCompany(i) {
  settings.companies.splice(i, 1);
  document.getElementById('settingsBody').innerHTML = renderSettingsForm();
}

// ============================================================
// Rendering
// ============================================================
function renderAll(container) {
  const wrap = container === 'today' ? document.getElementById('view-today') : document.getElementById('modalBody');
  if (!wrap) return;
  renderTasksTo(container, wrap.querySelector(container==='today'?'#taskList':'#hist-taskList'), currentData.tasks);
  renderItemsTo(container, 'learnings', wrap.querySelector(container==='today'?'#learningList':'#hist-learningList'), currentData.learnings, 'numbered');
  renderItemsTo(container, 'outputs', wrap.querySelector(container==='today'?'#outputList':'#hist-outputList'), currentData.outputs, 'bullet');
  // 参考资料用独立的 refsData
  if (container === 'today') {
    renderItemsTo(container, 'references', wrap.querySelector('#refList'), refsData, 'bullet');
  }
  updateAllCounts(container);
}

function renderTasksTo(ctx, list, tasks) {
  if (!list) return;
  list.innerHTML = tasks.map((t,i) => `
    <li class="task-item ${t.done?'task-done':''}">
      <input type="checkbox" class="task-checkbox" ${t.done?'checked':''} onchange="setTask('${ctx}',${i},this.checked)">
      <div class="task-text" contenteditable oninput="setTaskText('${ctx}',${i},this.innerText)" onblur="setTaskText('${ctx}',${i},this.innerText)">${esc(t.text)}</div>
      <button class="task-delete" onclick="delTask('${ctx}',${i})">×</button>
    </li>`).join('');
}

function renderItemsTo(ctx, field, list, items, style) {
  if (!list) return;
  const numbered = style === 'numbered';
  list.innerHTML = items.map((text,i) => {
    const imgMatch = matchImageUrl(text);
    let imgHtml = '';
    if (imgMatch) {
      imgHtml = `<img class="ref-image-thumb" src="${esc(imgMatch.url)}" alt="${esc(imgMatch.alt||'图片')}" onclick="event.stopPropagation();openLightbox('${esc(imgMatch.url)}')" loading="lazy">`;
    }
    return `
    <li class="item-row ${imgMatch?'has-image':''}">
      ${numbered?`<span class="item-number">${i+1}.</span>`:`<span class="item-dot">•</span>`}
      <div style="flex:1;min-width:0;">
        <div class="item-input" contenteditable oninput="setItemText('${ctx}','${field}',${i},this.innerText)" onblur="setItemText('${ctx}','${field}',${i},this.innerText)">${imgMatch ? esc(imgMatch.textBefore||text) : esc(text)}</div>
        ${imgHtml}
      </div>
      <button class="item-delete" onclick="delItem('${ctx}','${field}',${i})">×</button>
    </li>`;
  }).join('');
}

// ============================================================
// Image detection & lightbox
// ============================================================
function matchImageUrl(text) {
  if (!text) return null;
  // 匹配：http(s)://、相对路径 /uploads/、data:image、blob
  const imgRe = /((?:https?:\/\/|\/)\S+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?\S*)?|data:image\/\S+|blob:https?:\/\/\S+)/i;
  const m = text.match(imgRe);
  if (!m) return null;
  const url = m[1];
  const textBefore = text.replace(url, '').trim();
  let alt = '';
  const altMatch = textBefore.match(/^(.+?)[：:]\s*$/);
  if (altMatch) alt = altMatch[1];
  return { url, textBefore, alt };
}

function openLightbox(url) {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightbox').classList.add('show');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('show');
}

// ============================================================
// Actions - instant DOM updates, debounced save
// ============================================================
function setTask(ctx,i,done){
  currentData.tasks[i].done=done;
  // 直接更新 DOM 的 task-done class
  const pfx=ctx==='today'?'':'hist-';
  const list=document.getElementById(pfx+'taskList');
  if(list&&list.children[i]){
    if(done) list.children[i].classList.add('task-done');
    else list.children[i].classList.remove('task-done');
  }
  if(ctx==='today'){updateTaskStats();autoSave();}
  else updateAllCounts(ctx);
}
function setTaskText(ctx,i,text){
  currentData.tasks[i].text=text.trim();
}

function delTask(ctx,i){
  currentData.tasks.splice(i,1);
  // 直接移除 DOM 元素
  const pfx=ctx==='today'?'':'hist-';
  const list=document.getElementById(pfx+'taskList');
  if(list&&list.children[i])list.children[i].remove();
  // 更新后续 checkbox 的 onchange 索引
  refreshTaskBindings(ctx);
  syncCtx(ctx);
}

function refreshTaskBindings(ctx){
  const pfx=ctx==='today'?'':'hist-';
  const list=document.getElementById(pfx+'taskList');
  if(!list)return;
  Array.from(list.children).forEach((li,idx)=>{
    const cb=li.querySelector('.task-checkbox');
    const txt=li.querySelector('.task-text');
    const del=li.querySelector('.task-delete');
    if(cb)cb.setAttribute('onchange',`setTask('${ctx}',${idx},this.checked)`);
    if(txt){txt.setAttribute('oninput',`setTaskText('${ctx}',${idx},this.innerText)`);txt.setAttribute('onblur',`setTaskText('${ctx}',${idx},this.innerText)`);}
    if(del)del.setAttribute('onclick',`delTask('${ctx}',${idx})`);
  });
}

function setItemText(ctx,field,i,text){
  if(currentData[field])currentData[field][i]=text.trim();
}

function delItem(ctx,field,i){
  if(!currentData[field])return;
  currentData[field].splice(i,1);
  // 直接移除 DOM 元素
  const ids={learnings:'learningList',outputs:'outputList',experiences:'experienceList'};
  const pfx=ctx==='today'?'':'hist-';
  const list=document.getElementById(pfx+(ids[field]||''));
  if(list&&list.children[i]){
    list.children[i].style.transition='opacity 0.15s, transform 0.15s';
    list.children[i].style.opacity='0';
    list.children[i].style.transform='translateX(20px)';
    setTimeout(()=>{
      if(list.children[i])list.children[i].remove();
      refreshItemBindings(ctx,field);
      syncCtx(ctx);
    },150);
  } else {
    syncCtx(ctx);
  }
}

function refreshItemBindings(ctx,field){
  const ids={learnings:'learningList',outputs:'outputList',experiences:'experienceList'};
  const pfx=ctx==='today'?'':'hist-';
  const list=document.getElementById(pfx+(ids[field]||''));
  if(!list)return;
  const numbered=(field==='learnings'||field==='experiences');
  Array.from(list.children).forEach((li,idx)=>{
    const num=li.querySelector('.item-number');
    if(num&&numbered)num.textContent=(idx+1)+'.';
    const inp=li.querySelector('.item-input');
    const del=li.querySelector('.item-delete');
    if(inp){inp.setAttribute('oninput',`setItemText('${ctx}','${field}',${idx},this.innerText)`);inp.setAttribute('onblur',`setItemText('${ctx}','${field}',${idx},this.innerText)`);}
    if(del)del.setAttribute('onclick',`delItem('${ctx}','${field}',${idx})`);
  });
}

function syncCtx(ctx){updateAllCounts(ctx);if(ctx==='today'){updateTaskStats();autoSave();}}

function addTask(){
  currentData.tasks.push({text:'',done:false});
  renderAll('today');autoSave();
  setTimeout(()=>{const el=document.querySelectorAll('#taskList .task-text');if(el.length)el[el.length-1].focus();},100);
}
function addItem(field){
  if(!currentData[field])currentData[field]=[];
  currentData[field].push('');
  const ctx=editingDate?'history':'today';
  renderAll(ctx);autoSave();
  const lid={learnings:'learningList',outputs:'outputList',experiences:'experienceList'}[field];
  const pfx=ctx==='history'?'hist-':'';
  setTimeout(()=>{const el=document.querySelectorAll(`#${pfx}${lid} .item-input`);if(el.length)el[el.length-1].focus();},100);
}
function updateTaskStats(){const d=currentData.tasks.filter(t=>t.done).length;const el=document.getElementById('taskStats');if(el)el.textContent=`${d}/${currentData.tasks.length}`;}
function updateAllCounts(ctx){const pfx=ctx==='today'?'':'hist-';const set=(id,v)=>{const el=document.getElementById(pfx+id);if(el)el.textContent=v;};if(ctx==='today')updateTaskStats();set('learnCount',currentData.learnings.length);set('outputCount',currentData.outputs.length);set('expCount',currentData.experiences.length);}

// ============================================================
// Save
// ============================================================
function debounceAutoSave(){clearTimeout(autoSaveTimer);autoSaveTimer=setTimeout(autoSave,100);}
async function autoSave(){if(editingDate)return;try{const r=await api('/api/save','POST',{date:TODAY,tasks:currentData.tasks,learnings:currentData.learnings,outputs:currentData.outputs,experiences:currentData.experiences});if(r&&r.ok)document.getElementById('lastSaved').textContent='已保存 '+new Date().toLocaleTimeString();}catch(e){}}
async function saveAll(dateOverride){const btn=dateOverride?document.getElementById('histSaveBtn'):document.getElementById('saveBtn');if(btn)btn.textContent='⏳ 保存中...';const sd=dateOverride||TODAY;try{await api('/api/save','POST',{date:sd,...currentData});if(btn){btn.textContent='✅ 已保存';setTimeout(()=>{btn.textContent='💾 保存记录';},2000);}if(!dateOverride)document.getElementById('lastSaved').textContent=`保存于 ${new Date().toLocaleTimeString()}`;showToast('保存成功');}catch(e){if(btn)btn.textContent='❌ 失败';}}

// ============================================================
// History
// ============================================================
async function loadHistory(){const c=document.getElementById('historyList');try{const{dates}=await api('/api/dates');if(!dates.length){c.innerHTML='<div class="empty-state"><div class="icon">📭</div><p>暂无</p></div>';return;}const summaries=await Promise.all(dates.map(async d=>{try{const data=await api(`/api/record/${d}`);const done=(data.tasks||[]).filter(t=>t.done).length;const total=(data.tasks||[]).length;const parts=[];if(total)parts.push(`任务${done}/${total}`);if((data.outputs||[]).length)parts.push(`产出${data.outputs.length}`);if((data.learnings||[]).length)parts.push(`收获${data.learnings.length}`);return{date:d,summary:parts.join(' · ')||'空记录'};}catch(e){return{date:d,summary:'加载失败'};}}));c.innerHTML=summaries.map(s=>{const dd=new Date(s.date);const wd=['周日','周一','周二','周三','周四','周五','周六'];return`<div class="history-date-card" onclick="editRecord('${s.date}')"><div style="flex:1;min-width:0;"><div class="history-date">${s.date} <span class="history-weekday">${wd[dd.getDay()]}</span></div><div class="history-summary">${s.summary}</div></div><button style="background:none;border:none;color:#ccc;font-size:16px;padding:4px 8px;cursor:pointer;z-index:1;" onclick="event.stopPropagation();deleteRecord('${s.date}')" title="删除">🗑</button><span class="history-arrow">›</span></div>`;}).join('');}catch(e){c.innerHTML='<div class="empty-state"><p>加载失败</p></div>';}}

async function editRecord(dateStr){try{const data=await api(`/api/record/${dateStr}`);if(data.error){showToast('记录不存在');return;}editingDate=dateStr;currentData=normalize(data);document.getElementById('modalTitle').textContent=`✏️ 编辑 ${dateStr}`;document.getElementById('modalBody').innerHTML=renderEditForm();document.getElementById('modalOverlay').classList.add('show');renderAll('history');}catch(e){showToast('加载失败');}}

function newRecord(){
  // 弹出日期选择弹窗
  const d = document.getElementById('datePickerInput');
  document.getElementById('datePickerOverlay').classList.add('show');
  document.getElementById('datePickerInput').value = TODAY;
  setTimeout(() => document.getElementById('datePickerInput').focus(), 300);
}

function confirmNewRecord(){
  const d = document.getElementById('datePickerInput').value;
  if (!d) { showToast('请选择日期'); return; }
  document.getElementById('datePickerOverlay').classList.remove('show');
  editingDate = d;
  currentData = { tasks: [], learnings: [], outputs: [], experiences: [] };
  document.getElementById('modalTitle').textContent = `➕ 新增 ${d}`;
  document.getElementById('modalBody').innerHTML = renderEditForm();
  document.getElementById('modalOverlay').classList.add('show');
  renderAll('history');
}

async function deleteRecord(dateStr){
  if (!confirm(`确定删除 ${dateStr} 的记录吗？此操作不可恢复。`)) return;
  try {
    const res = await api(`/api/record/${dateStr}`, 'DELETE');
    if (res.ok) { showToast('已删除'); loadHistory(); }
    else { showToast('删除失败'); }
  } catch(e) { showToast('删除失败'); }
}

function renderEditForm(){return`
<div class="card"><div class="card-header"><div class="card-title">📋 任务</div><span class="card-badge" id="hist-taskStats">0/0</span></div><ul class="task-list" id="hist-taskList"></ul><button class="add-btn" onclick="addTaskInModal()">＋ 添加任务</button></div>
<div class="card"><div class="card-header"><div class="card-title">💡 收获</div><span class="card-badge" id="hist-learnCount">0</span></div><ul class="item-list" id="hist-learningList"></ul><div style="display:flex;gap:8px;"><button class="add-btn" onclick="addItemInModal('learnings')" style="flex:1;">＋ 添加收获</button><button class="add-btn" onclick="triggerUpload('learnings')" style="flex:0;font-size:18px;">📷</button></div></div>
<div class="card"><div class="card-header"><div class="card-title">📦 产出</div><span class="card-badge" id="hist-outputCount">0</span></div><ul class="item-list" id="hist-outputList"></ul><div style="display:flex;gap:8px;"><button class="add-btn" onclick="addItemInModal('outputs')" style="flex:1;">＋ 添加产出</button><button class="add-btn" onclick="triggerUpload('outputs')" style="flex:0;font-size:18px;">📷</button></div></div>
<div class="card"><div class="card-header"><div class="card-title">📌 经验</div><span class="card-badge" id="hist-expCount">0</span></div><ul class="item-list" id="hist-experienceList"></ul><button class="add-btn" onclick="addItemInModal('experiences')">＋ 添加经验</button></div>
<button class="save-btn" id="histSaveBtn" onclick="saveHistoryEdit()">💾 保存修改</button>`;}

function addTaskInModal(){currentData.tasks.push({text:'',done:false});renderAll('history');setTimeout(()=>{const el=document.querySelectorAll('#hist-taskList .task-text');if(el.length)el[el.length-1].focus();},100);}
function addItemInModal(field){currentData[field].push('');renderAll('history');const lid={learnings:'hist-learningList',outputs:'hist-outputList',experiences:'hist-experienceList'}[field];setTimeout(()=>{const el=document.querySelectorAll(`#${lid} .item-input`);if(el.length)el[el.length-1].focus();},100);}
async function saveHistoryEdit(){await saveAll(editingDate);closeModal();loadHistory();}
function closeModal(event){if(event&&event.target!==document.getElementById('modalOverlay'))return;document.getElementById('modalOverlay').classList.remove('show');editingDate=null;}

// ============================================================
// Report
// ============================================================
function initReport() {
  const today = new Date();
  const iso = getISOWeek(today);
  // 只在用户生成过周报时才恢复，否则显示当前周
  const savedYear = localStorage.getItem('reportYear');
  const savedWeek = localStorage.getItem('reportWeek');
  if (savedYear && savedWeek && localStorage.getItem('reportGenerated') === '1') {
    currentReportYear = parseInt(savedYear);
    currentReportWeek = parseInt(savedWeek);
  } else {
    currentReportYear = iso.year;
    currentReportWeek = iso.week;
  }
  refreshWeekNav();
  document.getElementById('reportContent').innerHTML = '';
  const btn = document.getElementById('genBtn');
  btn.style.display = 'block';
  btn.textContent = '🚀 生成周报';
  btn.disabled = false;
  loadSettings().then(() => {
    refreshWeekNav();
    const hint = document.getElementById('settingsHint');
    if (hint && (!settings.companies || !settings.companies.length)) {
      hint.style.display = 'block';
    } else if (hint) {
      hint.style.display = 'none';
    }
  });
}

function calcCompanyWeekForMonday(mondayStr) {
  // 根据入职日期计算到指定周一的入职周数
  const monday = new Date(mondayStr + 'T00:00:00');
  const result = [];
  for (const c of (settings.companies || [])) {
    const start = new Date(c.start_date + 'T00:00:00');
    const days = Math.floor((monday - start) / 86400000);
    if (days >= 0) result.push({ name: c.name, week_num: Math.floor(days / 7) + 1 });
  }
  return result;
}

function refreshWeekNav() {
  const weeks = settings.current_weeks || settings.company_weeks || [];
  let label;
  if (weeks.length) {
    label = weeks.map(w => `${w.name}第${w.week_num}周`).join(' · ');
  } else {
    label = `第 ${currentReportWeek} 周`;
  }
  document.getElementById('weekNav').innerHTML = `
    <button onclick="navigateWeek(-1)">‹</button>
    <span class="week-label">${label}</span>
    <button onclick="navigateWeek(1)">›</button>
    <button onclick="goCurrentWeek()" style="font-size:12px;">今天</button>`;
}

function goCurrentWeek() {
  const iso = getISOWeek(new Date());
  currentReportYear = iso.year;
  currentReportWeek = iso.week;
  localStorage.removeItem('reportYear');
  localStorage.removeItem('reportWeek');
  localStorage.removeItem('reportGenerated');
  refreshWeekNav();
  document.getElementById('reportContent').innerHTML = '';
  const btn = document.getElementById('genBtn');
  btn.style.display = 'block';
  btn.textContent = '🚀 生成周报';
  btn.disabled = false;
}
function navigateWeek(delta) {
  const jan4 = new Date(currentReportYear, 0, 4);
  const pyWeekday = (jan4.getDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - pyWeekday);
  const targetMonday = new Date(week1Monday);
  targetMonday.setDate(week1Monday.getDate() + (currentReportWeek - 1 + delta) * 7);
  const iso = getISOWeek(targetMonday);
  currentReportYear = iso.year; currentReportWeek = iso.week;
  localStorage.setItem('reportYear', currentReportYear);
  localStorage.setItem('reportWeek', currentReportWeek);
  // 用目标周一计算入职周数
  const mondayStr = targetMonday.getFullYear() + '-' + String(targetMonday.getMonth()+1).padStart(2,'0') + '-' + String(targetMonday.getDate()).padStart(2,'0');
  settings.company_weeks = calcCompanyWeekForMonday(mondayStr);
  refreshWeekNav();
  document.getElementById('reportContent').innerHTML = '';
  const btn = document.getElementById('genBtn');
  btn.style.display = 'block';
  btn.textContent = '🚀 生成周报';
  btn.disabled = false;
}

async function generateReport() {
  const btn = document.getElementById('genBtn');
  btn.textContent = '⏳ 生成中...'; btn.disabled = true;
  localStorage.setItem('reportYear', currentReportYear);
  localStorage.setItem('reportWeek', currentReportWeek);
  localStorage.setItem('reportGenerated', '1');
  try {
    await loadSettings();
    const data = await api(`/api/report?year=${currentReportYear}&week=${currentReportWeek}`);
    if (!data || data.error) {
      showToast('生成失败，请重试');
      btn.textContent = '🚀 重试'; btn.disabled = false;
      return;
    }
    renderReport(data);
    btn.style.display = 'none';
  } catch(e) {
    document.getElementById('reportContent').innerHTML = '<div class="empty-state"><p>加载失败</p></div>';
    btn.textContent = '🚀 重试'; btn.disabled = false;
  }
}

function getISOWeek(d){const t=new Date(d.valueOf());const day=(t.getDay()+6)%7;t.setDate(t.getDate()-day+3);const jan4=new Date(t.getFullYear(),0,4);const w1m=new Date(jan4);w1m.setDate(jan4.getDate()-(jan4.getDay()+6)%7);return{year:t.getFullYear(),week:1+Math.round((t-w1m)/604800000)};}

function renderReport(data){
  if (!data) return;
  // 用周报返回的日期重新计算入职周数
  if (data.monday && settings.companies) {
    settings.company_weeks = calcCompanyWeekForMonday(data.monday);
  }
  settings.current_weeks = null;
  refreshWeekNav();

  const rate = data.completion_rate;
  let cwHtml = '';
  if ((data.company_weeks||[]).length) {
    cwHtml = data.company_weeks.map(c => `${c.name}第${c.week_num}周`).join(' · ');
  }

  let html = `
  <div class="report-header-card">
    <div class="report-week-title">📊 周报 ${cwHtml||''}</div>
    <div class="report-date-range">${data.monday} ~ ${data.sunday} · ${data.record_count} 天记录</div>
    <div class="stat-grid">
      <div class="stat-item"><div class="stat-value">${data.tasks_done}/${data.tasks_total}</div><div class="stat-label">完成/总任务</div></div>
      <div class="stat-item"><div class="stat-value">${rate}%</div><div class="stat-label">完成率</div></div>
    </div>
  </div>
  <div style="font-size:15px;font-weight:600;margin-bottom:4px;">📋 周报总结（可编辑后复制）</div>
  <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;">以下文本可直接复制粘贴到钉钉，也支持修改</div>
  <div class="dingtalk-box" id="dingtalkText" contenteditable="true">${esc(data.dingtalk_text||'')}</div>
  <button class="copy-btn" id="copyBtn" onclick="copyDingtalk()">📋 一键复制，粘贴到钉钉</button>`;
  document.getElementById('reportContent').innerHTML = html;
}

async function copyDingtalk(){
  const el = document.getElementById('dingtalkText');
  const text = el ? el.innerText : '';
  try{await navigator.clipboard.writeText(text);}catch(e){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.left='-9999px';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}
  const btn=document.getElementById('copyBtn');btn.textContent='✅ 已复制！去钉钉粘贴吧';btn.classList.add('copied');showToast('已复制');setTimeout(()=>{btn.textContent='📋 一键复制，粘贴到钉钉';btn.classList.remove('copied');},2500);
}

// ============================================================
// References (首页固定)
// ============================================================
let refsData = [];

async function loadRefs(){
  try{const r=await api('/api/references');refsData=r.references||[];renderRefs();}catch(e){}
}

async function saveRefs(){
  try{await api('/api/references','POST',{references:refsData});}catch(e){}
}

function renderRefs(){
  const list=document.getElementById('refList');if(!list)return;
  list.innerHTML=refsData.map((text,i)=>{
    const imgMatch=matchImageUrl(text);
    let imgHtml='';
    if(imgMatch)imgHtml=`<img class="ref-image-thumb" src="${esc(imgMatch.url)}" alt="${esc(imgMatch.alt||'图片')}" onclick="event.stopPropagation();openLightbox('${esc(imgMatch.url)}')" loading="lazy">`;
    return`<li class="item-row ${imgMatch?'has-image':''}">
      <span class="item-dot">•</span>
      <div style="flex:1;min-width:0;">
        <div class="item-input" contenteditable oninput="setRefText(${i},this.innerText)" onblur="setRefText(${i},this.innerText)">${imgMatch?esc(imgMatch.textBefore||text):esc(text)}</div>
        ${imgHtml}
      </div>
      <button class="item-delete" onclick="delRef(${i})">×</button>
    </li>`;
  }).join('');
  document.getElementById('refCount').textContent=refsData.length;
}

function addRefItem(){
  refsData.push('');
  renderRefs();autoSaveRefs();
  setTimeout(()=>{const el=document.querySelectorAll('#refList .item-input');if(el.length)el[el.length-1].focus();},100);
}

function setRefText(i,text){refsData[i]=text.trim();autoSaveRefs();}
function delRef(i){refsData.splice(i,1);renderRefs();autoSaveRefs();}
function autoSaveRefs(){clearTimeout(window._refSaveTimer);window._refSaveTimer=setTimeout(saveRefs,3000);}

// ============================================================
// Utils
// ============================================================
// ============================================================
// Image Upload
// ============================================================
let uploadTargetField = 'references';

function triggerUpload(field){
  uploadTargetField = field || 'references';
  const inp = document.getElementById('uploadInput');
  inp.value = '';  // 清空，确保 change 事件触发
  inp.click();
}

async function handleUpload(input){
  const file = input.files[0];
  if (!file) return;
  try {
    showToast('上传中...');
    // Read as base64
    const reader = new FileReader();
    reader.onload = async function(){
      const b64 = reader.result;
      const res = await api('/api/upload', 'POST', {data: b64});
      if (res && res.ok) {
        const url = res.url;
        if (!currentData[uploadTargetField]) currentData[uploadTargetField] = [];
        currentData[uploadTargetField].push(url);
        const ctx = editingDate ? 'history' : 'today';
        renderAll(ctx);
        if (uploadTargetField === 'references') { refsData.push(url); renderRefs(); autoSaveRefs(); }
        else { autoSave(); }
        showToast('图片已上传');
      } else {
        showToast('上传失败');
      }
    };
    reader.readAsDataURL(file);
  } catch(e) { showToast('上传失败'); }
  input.value = '';
}

function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2000);}
