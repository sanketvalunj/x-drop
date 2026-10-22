/* Browser UI for the local xdrop dashboard. */
const root = document.querySelector('#view');
const pageName = document.querySelector('#page-name');
const toast = document.querySelector('#toast');
let state = null;
let currentView = 'overview';
let historySearch = '';
let historyDirection = 'all';
let historyStatus = 'all';
let toastTimer;

const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const size = bytes => {
  if (!Number.isFinite(Number(bytes))) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB','MB','GB','TB'];
  let value = n / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};
const timeLabel = stamp => {
  if (!stamp) return 'just now';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - stamp));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function notify(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = 'toast', 2800);
}
async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
function deviceRow(peer, compact = false) {
  return `<div class="device-row"><div class="device-avatar">${escapeHTML((peer.name || '?').slice(0,1).toUpperCase())}</div><div class="device-info"><strong>${escapeHTML(peer.name)}</strong><span>${escapeHTML(peer.address)} · online now</span></div><button class="button button-secondary button-small" data-send-peer="${escapeHTML(peer.address)}:${peer.port}">Send file <span>↗</span></button></div>`;
}
function incomingCard(item) {
  const pending = item.status === 'pending';
  const status = item.status === 'active' ? `${size(item.received)} of ${size(item.size)} received` : `${item.status}${item.verified ? ' · verified' : ''}`;
  return `<div class="incoming-card"><div class="device-avatar">↓</div><div class="incoming-info"><strong>${escapeHTML(item.filename)}</strong><span>${escapeHTML(item.sender)} · ${size(item.size)} · ${escapeHTML(item.address || '')}</span><span class="status-text ${item.status === 'failed' ? 'failed' : item.status === 'done' ? 'done' : ''}">${escapeHTML(status)}</span></div>${pending ? `<div class="incoming-actions"><button class="button button-secondary" data-decision="accept" data-id="${escapeHTML(item.id)}">Accept</button><button class="button button-quiet" data-decision="reject" data-id="${escapeHTML(item.id)}">Decline</button></div>` : ''}</div>`;
}
function transferCard(item, direction) {
  const sent = Number(item.sent || item.received || 0);
  const total = Number(item.size || 0);
  const percent = total ? Math.min(100, Math.round(100 * sent / total)) : 0;
  const done = ['done','failed','rejected','cancelled'].includes(item.status);
  const speed = Number(item.speed_bps || 0);
  const eta = speed > 0 ? ` · ${Math.ceil(Math.max(0,total-sent)/speed)}s left` : '';
  const status = item.status === 'done' ? 'Complete' : item.status === 'cancelled' ? 'Cancelled' : item.status === 'failed' ? (item.error || 'Failed') : item.status === 'connecting' ? 'Waiting for receiver' : `${percent}% · ${size(speed)}/s${eta}`;
  const mark = item.status === 'done' ? '✓' : item.status === 'failed' ? '!' : item.status === 'cancelled' ? '×' : '⇅';
  return `<div class="file-card"><div class="file-icon">${mark}</div><div class="file-meta"><strong>${escapeHTML(item.filename)}</strong><span>${direction === 'out' ? `To ${escapeHTML(item.peer)}` : `From ${escapeHTML(item.sender)}`} · ${size(total)}${item.error ? ` · ${escapeHTML(item.error)}` : ''}</span>${!done ? `<div class="progress-wrap"><i style="width:${percent}%"></i></div>` : ''}</div><div class="transfer-status">${escapeHTML(status)}</div>${item.can_cancel ? `<button class="button button-danger button-small" data-cancel-transfer="${escapeHTML(item.id)}">Cancel</button>` : ''}${direction === 'out' && item.can_resume ? `<button class="button button-secondary button-small" data-resume-transfer="${escapeHTML(item.id)}">Resume</button>` : ''}</div>`;
}
function heading(kicker, title, subtitle, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
function overview() {
  const peers = state.peers || [];
  const incoming = state.incoming || [];
  const pending = incoming.filter(item => item.status === 'pending');
  const activity = [...(state.outgoing || []).map(item => ({...item, direction:'out'})), ...incoming.map(item => ({...item, direction:'in'}))].sort((a,b) => (b.started_at || 0) - (a.started_at || 0)).slice(0,4);
  const activityHTML = activity.length ? activity.map(item => `<div class="activity-row"><div class="activity-mark">${item.status === 'done' ? '✓' : item.direction === 'out' ? '↑' : '↓'}</div><div class="activity-info"><strong>${escapeHTML(item.filename)}</strong><span>${item.direction === 'out' ? `To ${escapeHTML(item.peer)}` : `From ${escapeHTML(item.sender)} `} · ${timeLabel(item.started_at)}</span><div class="status-text ${item.status === 'done' ? 'done' : item.status === 'failed' ? 'failed' : ''}">${escapeHTML(item.status)}</div></div></div>`).join('') : `<div class="empty"><strong>Nothing shared yet</strong>Your recent file activity will show up here.</div>`;
  return `${heading('YOUR SPACE',`Welcome back, ${escapeHTML(state.device_name)}`, 'Your files move directly between devices on your network.', '<button class="button button-quiet" data-action="refresh">↻ &nbsp;Refresh</button>')}
    <section class="hero"><div class="hero-copy"><div class="hero-kicker"><i></i> Private by design</div><h2>Share files. Stay in sync.</h2><p>Send files directly to devices on your local network. Every transfer is encrypted and verified.</p><button class="button" data-action="send"><span class="plus">＋</span> Send a file</button></div><div class="hero-art"><div class="orbit"></div><div class="orbit two"></div><i class="orbit-dot"></i><div class="art-core">⇄</div></div></section>
    <div class="stat-grid"><div class="stat-card"><div class="stat-icon">◉</div><div class="stat-text"><span>DEVICES NEARBY</span><strong>${peers.length} online</strong></div></div><div class="stat-card"><div class="stat-icon">↓</div><div class="stat-text"><span>NEEDS YOUR ATTENTION</span><strong>${pending.length} incoming</strong></div></div><div class="stat-card"><div class="stat-icon">▤</div><div class="stat-text"><span>SAVING FILES TO</span><strong title="${escapeHTML(state.download_dir)}">${escapeHTML(state.download_dir.split('/').pop() || state.download_dir)}</strong></div></div></div>
    ${pending.length ? `<section class="section-block"><div class="section-head"><h2>Incoming requests <span class="nav-count">${pending.length}</span></h2><button class="text-link" data-view="transfers">View all</button></div>${pending.map(incomingCard).join('')}</section>` : ''}
    <div class="columns"><section><div class="section-head"><h2>Devices nearby</h2><button class="text-link" data-view="devices">See all</button></div><div class="card device-list">${peers.length ? peers.slice(0,4).map(peer => deviceRow(peer,true)).join('') : `<div class="empty"><div class="empty-mark">◉</div><strong>No devices found yet</strong>Make sure your other device is on the same Wi-Fi network.</div>`}</div></section><section><div class="section-head"><h2>Recent activity</h2><button class="text-link" data-view="transfers">History</button></div><div class="card activity-list">${activityHTML}</div></section></div>`;
}
function devicesView() {
  const peers = state.peers || [];
  return `${heading('NETWORK','Devices','Choose a nearby device or connect directly with an IP address.')}
    <section class="connect-card"><div class="connect-copy"><div class="eyebrow">DIRECT CONNECTION</div><h2>Connect by IP</h2><p>Enter the address and transfer port shown in xdrop on the other device.</p></div><form id="connect-form"><label class="sr-only" for="connect-address">Device IP address and port</label><div class="connect-controls"><input id="connect-address" placeholder="192.168.1.24:50000" autocomplete="off" required><button class="button button-primary" type="submit">Continue <span>→</span></button></div><span class="connect-error" id="connect-error" aria-live="polite"></span><span class="field-hint">Example: 192.168.1.24:50000 · Use an IPv4 address or device hostname.</span></form></section>
    <div class="section-head device-section-head"><h2>Nearby devices</h2><span class="field-hint">${peers.length} available</span></div>${peers.length ? `<div class="device-grid">${peers.map(peer => `<article class="device-card"><div class="device-card-head"><div class="device-avatar">${escapeHTML((peer.name || '?').slice(0,1).toUpperCase())}</div><div><strong>${escapeHTML(peer.name)}</strong><span>Available now</span></div></div><div class="device-address">${escapeHTML(peer.address)}:${peer.port}</div><button class="button button-secondary" data-send-peer="${escapeHTML(peer.address)}:${peer.port}">Send a file <span>↗</span></button></article>`).join('')}</div>` : `<div class="card empty"><div class="empty-mark">◉</div><strong>No nearby devices</strong>Keep xdrop open on another device connected to the same local network. Or use the Connect by IP form above.</div>`}`;
}
function sendView(selectedPeer = '') {
  const options = (state.peers || []).map(peer => `<option value="${escapeHTML(peer.address)}:${peer.port}" ${selectedPeer === `${peer.address}:${peer.port}` ? 'selected' : ''}>${escapeHTML(peer.name)} · ${escapeHTML(peer.address)}:${peer.port}</option>`).join('');
  return `${heading('NEW TRANSFER','Send files','Choose one or more files. Each arrives as its own encrypted transfer.')}
    <div class="card send-card"><form id="send-form"><div class="field"><label for="peer-target">SEND TO DEVICE</label><select id="peer-target" class="select-input"><option value="">${options ? 'Choose a nearby device' : 'No devices found · enter an address below'}</option>${options}</select></div><div class="manual-label">OR CONNECT DIRECTLY</div><div class="field"><label for="manual-peer">DEVICE ADDRESS</label><input id="manual-peer" placeholder="192.168.1.24:50000" value="${escapeHTML(selectedPeer)}"><span class="field-hint">Enter an IP address or hostname and port shown on the other device.</span></div><div class="field file-field"><label>CHOOSE FILES</label><label class="file-drop" id="drop-zone"><input id="file-input" type="file" multiple required><span class="drop-icon">↑</span><strong>Drop files here</strong><span class="drop-caption">or <b>browse files</b></span><span class="selected-file" id="selected-file">Select or drop multiple files to send them one by one.</span></label></div><div class="form-actions"><button class="button button-primary" type="submit">Send files securely <span>↗</span></button><button class="button button-quiet" type="button" data-view="overview">Cancel</button></div><div class="upload-progress" id="upload-progress"></div></form></div>`;
}
function transfersView() {
  const rows = [
    ...(state.incoming || []).map(item => ({...item, direction:'incoming'})),
    ...(state.outgoing || []).map(item => ({...item, direction:'outgoing'})),
  ].sort((a,b) => (b.started_at || 0) - (a.started_at || 0));
  const content = rows.length ? rows.map(item => {
    const status = ['connecting','sending'].includes(item.status) ? 'active' : item.status;
    const searchable = [item.filename,item.sender,item.peer,item.address].filter(Boolean).join(' ').toLowerCase();
    const card = item.direction === 'incoming' ? incomingCard(item) : transferCard(item,'out');
    return `<div class="history-row" data-direction="${item.direction}" data-status="${status}" data-search="${escapeHTML(searchable)}">${card}</div>`;
  }).join('') : `<div class="card empty"><strong>No transfers yet</strong>Incoming requests and sent files will appear here.</div>`;
  return `${heading('FILE ACTIVITY','Transfers','Search and filter incoming requests and outgoing files.','<button class="button button-quiet button-small" data-action="clear-history">Clear old history</button>')}
    <div class="history-toolbar"><label class="history-search"><span>⌕</span><input id="history-search" type="search" placeholder="Search files or devices" value="${escapeHTML(historySearch)}"></label><select id="history-direction" aria-label="Filter by direction"><option value="all" ${historyDirection==='all'?'selected':''}>All directions</option><option value="incoming" ${historyDirection==='incoming'?'selected':''}>Incoming</option><option value="outgoing" ${historyDirection==='outgoing'?'selected':''}>Outgoing</option></select><select id="history-status" aria-label="Filter by status"><option value="all" ${historyStatus==='all'?'selected':''}>All statuses</option>${['pending','active','done','failed','rejected','cancelled'].map(value=>`<option value="${value}" ${historyStatus===value?'selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select></div>
    <div class="history-list">${content}<div class="card empty history-no-results" hidden><strong>No matching transfers</strong>Try another search or filter.</div></div><div class="transfer-footer"><button class="text-link" data-action="send">Send a file ↗</button><span>Active and pending transfers stay when you clear history.</span></div>`;
}
function applyHistoryFilters() {
  const rows = [...root.querySelectorAll('.history-row')];
  if (!rows.length) return;
  let visible = 0;
  for (const row of rows) {
    const matches = (!historySearch || row.dataset.search.includes(historySearch.toLowerCase()))
      && (historyDirection === 'all' || row.dataset.direction === historyDirection)
      && (historyStatus === 'all' || row.dataset.status === historyStatus);
    row.hidden = !matches;
    if (matches) visible++;
  }
  const noResults = root.querySelector('.history-no-results');
  if (noResults) noResults.hidden = visible > 0;
}
function settingsView() {
  return `${heading('PREFERENCES','Settings','Personalize this device and choose where files are saved.')}
    <div class="settings-grid"><section class="setting-card"><h3>This device</h3><p>Your device name is shown to nearby xdrop users.</p><form id="name-form"><div class="field"><label for="device-name">DEVICE NAME</label><input id="device-name" maxlength="48" required value="${escapeHTML(state.device_name)}"></div><button class="button button-primary" type="submit">Save name</button></form></section>
    <section class="setting-card"><h3>Download location</h3><p>Received files are saved to this folder.</p><form id="folder-form"><div class="field"><label for="download-dir">FOLDER PATH</label><input id="download-dir" required value="${escapeHTML(state.download_dir)}"></div><div class="form-actions"><button class="button button-primary" type="submit">Save location</button><button class="button button-quiet" type="button" data-action="open-folder">Open folder ↗</button></div></form></section>
    <section class="setting-card"><h3>Pair another device</h3><p>Share your code, or scan a nearby xdrop code with this device’s camera.</p>${state.qr_available && state.local_ip ? `<div class="pairing-qr"><img src="/api/pairing.svg" alt="QR code for ${escapeHTML(state.local_ip)}:${state.port}"><div><strong>${escapeHTML(state.device_name)}</strong><span>Another device can scan this code and connect.</span><button class="button button-secondary button-small" type="button" data-action="scan-qr">▦ Scan a code</button></div></div>` : `<div class="qr-unavailable">${!state.qr_available ? 'Install xdrop dependencies to enable QR pairing.' : 'No local network address was detected.'}<button class="button button-secondary button-small" type="button" data-action="scan-qr">▦ Scan a code</button></div>`}<div class="copy-address-row"><div><span>Address and port</span><strong>${escapeHTML(state.local_ip ? `${state.local_ip}:${state.port}` : 'Address not detected')}</strong></div><button class="button button-quiet button-small" data-copy-address="${escapeHTML(state.local_ip ? `${state.local_ip}:${state.port}` : '')}" ${state.local_ip ? '' : 'disabled'}>Copy</button></div><div class="network-info"><span>Discovery</span><strong>${state.discovery.registered ? 'Available' : 'Limited'}</strong></div></section>
    <section class="setting-card"><h3>Privacy & security</h3><p>Each transfer uses a fresh encrypted connection and verifies file integrity before saving.</p><div class="security-line"><span class="security-check">✓</span><span><strong>End-to-end encrypted</strong><small>X25519 · AES-256-GCM · SHA-256</small></span></div></section></div>`;
}
function render() {
  if (!state) { root.innerHTML = '<div class="loading"><div><div class="spinner"></div>Connecting to your xdrop device…</div></div>'; return; }
  const names = {overview:'Overview',devices:'Devices',send:'Send a file',transfers:'Transfers',settings:'Settings'};
  pageName.textContent = names[currentView] || 'Overview';
  document.querySelector('#profile-name').textContent = state.device_name;
  document.querySelector('#avatar').textContent = (state.device_name || 'x').slice(0,1).toUpperCase();
  document.querySelector('#peer-count').textContent = (state.peers || []).length;
  document.querySelector('#version').textContent = state.version;
  const connection = document.querySelector('.connection');
  connection.classList.toggle('online', Boolean(state.discovery.zeroconf_active));
  document.querySelector('#connection-label').textContent = state.discovery.zeroconf_active ? 'Network active' : 'Local only';
  document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === currentView));
  root.innerHTML = ({overview,devices:devicesView,send:sendView,transfers:transfersView,settings:settingsView}[currentView] || overview)();
  if (currentView === 'transfers') applyHistoryFilters();
}
async function refresh() {
  try { state = await request('/api/state'); render(); }
  catch (error) { document.querySelector('#connection-label').textContent = 'Offline'; notify(error.message, true); }
}
function switchView(view, peer = '') {
  currentView = view;
  render();
  if (view === 'send' && peer) {
    const target = root.querySelector('#manual-peer');
    if (target) target.value = peer;
  }
}
document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]');
  if (nav) { switchView(nav.dataset.view); return; }
  const action = event.target.closest('[data-action]');
  if (action?.dataset.action === 'send') { switchView('send'); return; }
  if (action?.dataset.action === 'scan-qr') { await startQrScanner(); return; }
  if (action?.dataset.action === 'close-scanner') { closeQrScanner(); return; }
  if (action?.dataset.action === 'refresh' || event.target.closest('#refresh')) { await refresh(); notify('Updated'); return; }
  if (action?.dataset.action === 'open-folder') {
    try { await request('/api/open-download-folder',{method:'POST'}); notify('Opened download folder'); }
    catch (error) { notify(error.message, true); }
    return;
  }
  if (action?.dataset.action === 'clear-history') {
    if (!window.confirm('Clear completed transfer history? Active and pending transfers will be kept.')) return;
    try {
      const result = await request('/api/history/clear',{method:'POST'});
      await refresh();
      notify(`Cleared ${result.removed} old ${result.removed === 1 ? 'transfer' : 'transfers'}`);
    } catch (error) { notify(error.message, true); }
    return;
  }
  const copyButton = event.target.closest('[data-copy-address]');
  if (copyButton) {
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copyAddress);
      notify('Address and port copied');
    } catch (error) { notify('Could not copy address to clipboard', true); }
    return;
  }
  const peer = event.target.closest('[data-send-peer]');
  if (peer) { switchView('send', peer.dataset.sendPeer); return; }
  const decision = event.target.closest('[data-decision]');
  if (decision) {
    try { await request(`/api/incoming/${encodeURIComponent(decision.dataset.id)}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accept:decision.dataset.decision === 'accept'})}); await refresh(); notify(decision.dataset.decision === 'accept' ? 'Transfer accepted' : 'Request declined'); }
    catch (error) { notify(error.message, true); }
  }
  const cancel = event.target.closest('[data-cancel-transfer]');
  if (cancel) {
    try {
      await request(`/api/outgoing/${encodeURIComponent(cancel.dataset.cancelTransfer)}/cancel`,{method:'POST'});
      notify('Cancelling transfer…');
      if (currentView !== 'send') await refresh();
    }
    catch (error) { notify(error.message, true); }
    return;
  }
  const resume = event.target.closest('[data-resume-transfer]');
  if (resume) {
    try {
      await request(`/api/outgoing/${encodeURIComponent(resume.dataset.resumeTransfer)}/resume`,{method:'POST'});
      await refresh();
      notify('Resuming transfer…');
    } catch (error) { notify(error.message, true); }
    return;
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'peer-target' && event.target.value) {
    const manual = root.querySelector('#manual-peer');
    if (manual) manual.value = event.target.value;
  }
  if (event.target.id === 'file-input' && event.target.files.length) {
    const files = [...event.target.files];
    const selected = root.querySelector('#selected-file');
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (selected) selected.innerHTML = files.length === 1
      ? `<b>${escapeHTML(files[0].name)}</b> · ${size(totalBytes)}`
      : `<b>${files.length} files selected</b> · ${size(totalBytes)} total`;
  }
  if (event.target.id === 'history-direction') { historyDirection = event.target.value; applyHistoryFilters(); }
  if (event.target.id === 'history-status') { historyStatus = event.target.value; applyHistoryFilters(); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'history-search') { historySearch = event.target.value.trim(); applyHistoryFilters(); }
});
document.addEventListener('dragover', event => {
  if (event.target.closest('#drop-zone')) { event.preventDefault(); root.querySelector('#drop-zone')?.classList.add('dragging'); }
});
document.addEventListener('dragleave', event => {
  if (event.target.closest('#drop-zone') && !event.relatedTarget?.closest?.('#drop-zone')) root.querySelector('#drop-zone')?.classList.remove('dragging');
});
document.addEventListener('drop', event => {
  const zone = event.target.closest('#drop-zone');
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('dragging');
  const input = zone.querySelector('#file-input');
  if (!event.dataTransfer.files.length || !input) return;
  const transfer = new DataTransfer();
  for (const file of event.dataTransfer.files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (event.target.id === 'connect-form') {
      const input = root.querySelector('#connect-address');
      const errorLabel = root.querySelector('#connect-error');
      input.classList.remove('invalid');
      errorLabel.textContent = '';
      try {
        const peer = await request('/api/validate-peer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:input.value})});
        switchView('send', peer.label);
        notify(`Address checked: ${peer.label}`);
      } catch (error) {
        input.classList.add('invalid');
        errorLabel.textContent = error.message;
        input.focus();
      }
    } else if (event.target.id === 'name-form') {
      await request('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_name:root.querySelector('#device-name').value})});
      await refresh(); notify('Device name saved');
    } else if (event.target.id === 'folder-form') {
      await request('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({download_dir:root.querySelector('#download-dir').value})});
      await refresh(); notify('Download location saved');
    } else if (event.target.id === 'send-form') {
      const target = root.querySelector('#manual-peer').value.trim();
      const files = [...root.querySelector('#file-input').files];
      if (!files.length) throw new Error('Choose at least one file to send');
      const match = target.match(/^(.*):(\d+)$/);
      if (!match || !match[1] || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('Enter a device address and port, or choose a nearby device');
      const progress = root.querySelector('#upload-progress');
      let completed = 0;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        progress.innerHTML = `<div class="batch-message" id="batch-message">Preparing file ${index + 1} of ${files.length}: ${escapeHTML(file.name)}</div>`;
        const queued = await request(`/api/send?address=${encodeURIComponent(match[1])}&port=${match[2]}&filename=${encodeURIComponent(file.name)}`, {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
        progress.innerHTML = `<div class="batch-message" id="batch-message">Waiting for the receiver · file ${index + 1} of ${files.length}: ${escapeHTML(file.name)}</div>`;
        const result = await waitForOutgoing(queued.id, file.name, index + 1, files.length);
        if (result.status === 'done') completed++;
        if (result.status === 'cancelled') break;
      }
      await refresh();
      const message = completed === files.length ? `Sent all ${completed} files` : `Sent ${completed} of ${files.length} files`;
      notify(message);
      switchView('transfers');
    }
  } catch (error) { notify(error.message, true); }
});
async function waitForOutgoing(id, filename, index, total) {
  while (true) {
    const latest = await request('/api/state');
    state = latest;
    const item = (latest.outgoing || []).find(transfer => transfer.id === id);
    if (!item) throw new Error('Could not find the outgoing transfer status');
    const message = root.querySelector('#batch-message');
    if (message) {
      const percent = item.size ? Math.floor(item.sent * 100 / item.size) : 100;
      message.textContent = item.status === 'connecting'
        ? `Waiting for the receiver · file ${index} of ${total}: ${filename}`
        : `Sending ${index} of ${total} · ${percent}% · ${size(item.speed_bps)}/s`;
    }
    const progressBox = root.querySelector('#upload-progress');
    if (item.can_cancel && progressBox && !progressBox.querySelector('[data-cancel-transfer]')) {
      progressBox.insertAdjacentHTML('beforeend', `<button class="button button-danger button-small" data-cancel-transfer="${escapeHTML(id)}">Cancel current file</button>`);
    }
    if (['done','failed','cancelled'].includes(item.status)) return item;
    await wait(900);
  }
}
document.querySelector('#refresh').addEventListener('click', refresh);
let scannerStream = null;
let scannerTimer = null;
async function startQrScanner() {
  const video = document.querySelector('#scanner-video');
  const modal = document.querySelector('#scanner-modal');
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    notify('QR scanning is not supported in this browser. Enter the address manually.', true);
    switchView('send');
    return;
  }
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    video.srcObject = scannerStream;
    modal.hidden = false;
    await video.play();
    const detector = new BarcodeDetector({formats:['qr_code']});
    const scan = async () => {
      if (!scannerStream || modal.hidden) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const endpoint = String(codes[0].rawValue || '').trim();
          closeQrScanner();
          const peer = await request('/api/validate-peer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint})});
          switchView('send', peer.label);
          notify(`Address checked: ${peer.label}`);
          return;
        }
      } catch (error) { closeQrScanner(); notify(error.message || 'Could not read that QR code', true); return; }
      scannerTimer = setTimeout(scan, 250);
    };
    scannerTimer = setTimeout(scan, 250);
  } catch (error) {
    closeQrScanner();
    notify(error.name === 'NotAllowedError' ? 'Allow camera access to scan a QR code' : (error.message || 'Could not start the camera'), true);
  }
}
function closeQrScanner() {
  clearTimeout(scannerTimer);
  scannerTimer = null;
  if (scannerStream) scannerStream.getTracks().forEach(track => track.stop());
  scannerStream = null;
  const modal = document.querySelector('#scanner-modal');
  const video = document.querySelector('#scanner-video');
  if (modal) modal.hidden = true;
  if (video) video.srcObject = null;
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeQrScanner(); });
refresh();
setInterval(() => {
  const focusedControl = root.contains(document.activeElement) && document.activeElement.matches('input,select,textarea');
  if (currentView !== 'send' && !focusedControl) refresh();
}, 1200);
