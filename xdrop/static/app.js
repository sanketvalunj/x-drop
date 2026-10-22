/* Browser UI for the local xdrop dashboard. */
const root = document.querySelector('#view');
const pageName = document.querySelector('#page-name');
const toast = document.querySelector('#toast');
let state = null;
let currentView = 'overview';
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
  const status = item.status === 'done' ? 'Complete' : item.status === 'failed' ? (item.error || 'Failed') : `${direction === 'out' ? 'Sending' : 'Receiving'} · ${percent}%`;
  const mark = item.status === 'done' ? '✓' : item.status === 'failed' ? '!' : '⇅';
  return `<div class="file-card"><div class="file-icon">${mark}</div><div class="file-meta"><strong>${escapeHTML(item.filename)}</strong><span>${direction === 'out' ? `To ${escapeHTML(item.peer)}` : `From ${escapeHTML(item.sender)}`} · ${size(total)}</span>${!['done','failed','rejected','cancelled'].includes(item.status) ? `<div class="progress-wrap"><i style="width:${percent}%"></i></div>` : ''}</div><div class="transfer-status">${escapeHTML(status)}</div></div>`;
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
  return `${heading('NETWORK','Devices','Choose a nearby device to start a secure transfer.')}${peers.length ? `<div class="device-grid">${peers.map(peer => `<article class="device-card"><div class="device-card-head"><div class="device-avatar">${escapeHTML((peer.name || '?').slice(0,1).toUpperCase())}</div><div><strong>${escapeHTML(peer.name)}</strong><span>Available now</span></div></div><div class="device-address">${escapeHTML(peer.address)}:${peer.port}</div><button class="button button-secondary" data-send-peer="${escapeHTML(peer.address)}:${peer.port}">Send a file <span>↗</span></button></article>`).join('')}</div>` : `<div class="card empty"><div class="empty-mark">◉</div><strong>No nearby devices</strong>Keep xdrop open on another device connected to the same local network. You can also enter an IP address when sending.</div>`}`;
}
function sendView(selectedPeer = '') {
  const options = (state.peers || []).map(peer => `<option value="${escapeHTML(peer.address)}:${peer.port}" ${selectedPeer === `${peer.address}:${peer.port}` ? 'selected' : ''}>${escapeHTML(peer.name)} · ${escapeHTML(peer.address)}:${peer.port}</option>`).join('');
  return `${heading('NEW TRANSFER','Send a file','Choose a device and a file to send over your local network.')}
    <div class="card send-card"><form id="send-form"><div class="field"><label for="peer-target">SEND TO DEVICE</label><select id="peer-target" class="select-input" ${options ? '' : 'value=""'}><option value="">${options ? 'Choose a nearby device' : 'No devices found · enter an address below'}</option>${options}</select></div><div class="manual-label">OR CONNECT DIRECTLY</div><div class="field"><label for="manual-peer">DEVICE ADDRESS</label><input id="manual-peer" placeholder="192.168.1.24:50000" value="${escapeHTML(selectedPeer)}"><span class="field-hint">Enter an IP address or hostname and port shown on the other device.</span></div><div class="field file-field"><label for="file-input">CHOOSE A FILE</label><input id="file-input" type="file" required><span class="field-hint">Files are encrypted while they travel between devices.</span></div><div class="form-actions"><button class="button button-primary" type="submit">Send securely <span>↗</span></button><button class="button button-quiet" type="button" data-view="overview">Cancel</button></div><div class="upload-progress" id="upload-progress"></div></form></div>`;
}
function transfersView() {
  const incoming = [...(state.incoming || [])].sort((a,b) => (b.started_at || 0) - (a.started_at || 0));
  const outgoing = [...(state.outgoing || [])].sort((a,b) => (b.started_at || 0) - (a.started_at || 0));
  return `${heading('FILE ACTIVITY','Transfers','Incoming requests and your recent file sharing.')}
    <div class="section-head"><h2>Incoming</h2></div>${incoming.length ? incoming.map(incomingCard).join('') : `<div class="card empty"><strong>No incoming transfers</strong>Requests from other devices will appear here.</div>`}
    <div class="section-head transfer-head"><h2>Outgoing</h2><button class="text-link" data-action="send">Send a file</button></div>${outgoing.length ? outgoing.map(item => transferCard(item,'out')).join('') : `<div class="card empty"><strong>No outgoing transfers</strong>Files you send to other devices will appear here.</div>`}`;
}
function settingsView() {
  return `${heading('PREFERENCES','Settings','Personalize this device and choose where files are saved.')}
    <div class="settings-grid"><section class="setting-card"><h3>This device</h3><p>Your device name is shown to nearby xdrop users.</p><form id="name-form"><div class="field"><label for="device-name">DEVICE NAME</label><input id="device-name" maxlength="48" required value="${escapeHTML(state.device_name)}"></div><button class="button button-primary" type="submit">Save name</button></form></section>
    <section class="setting-card"><h3>Download location</h3><p>Received files are saved to this folder.</p><form id="folder-form"><div class="field"><label for="download-dir">FOLDER PATH</label><input id="download-dir" required value="${escapeHTML(state.download_dir)}"></div><button class="button button-primary" type="submit">Save location</button></form></section>
    <section class="setting-card"><h3>Network</h3><p>xdrop discovers devices on your local network with mDNS.</p><div class="network-info"><span>Local address</span><strong>${escapeHTML(state.local_ip || 'Not detected')}</strong><span>Transfer port</span><strong>${state.port}</strong><span>Discovery</span><strong>${state.discovery.registered ? 'Available' : 'Limited'}</strong></div></section>
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
  if (action?.dataset.action === 'refresh' || event.target.closest('#refresh')) { await refresh(); notify('Updated'); return; }
  const peer = event.target.closest('[data-send-peer]');
  if (peer) { switchView('send', peer.dataset.sendPeer); return; }
  const decision = event.target.closest('[data-decision]');
  if (decision) {
    try { await request(`/api/incoming/${encodeURIComponent(decision.dataset.id)}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accept:decision.dataset.decision === 'accept'})}); await refresh(); notify(decision.dataset.decision === 'accept' ? 'Transfer accepted' : 'Request declined'); }
    catch (error) { notify(error.message, true); }
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'peer-target' && event.target.value) {
    const manual = root.querySelector('#manual-peer');
    if (manual) manual.value = event.target.value;
  }
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (event.target.id === 'name-form') {
      await request('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_name:root.querySelector('#device-name').value})});
      await refresh(); notify('Device name saved');
    } else if (event.target.id === 'folder-form') {
      await request('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({download_dir:root.querySelector('#download-dir').value})});
      await refresh(); notify('Download location saved');
    } else if (event.target.id === 'send-form') {
      const target = root.querySelector('#manual-peer').value.trim();
      const file = root.querySelector('#file-input').files[0];
      if (!file) throw new Error('Choose a file to send');
      const match = target.match(/^(.*):(\d+)$/);
      if (!match || !match[1] || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('Enter a device address and port, or choose a nearby device');
      const progress = root.querySelector('#upload-progress');
      progress.innerHTML = `<div class="progress-wrap"><i style="width:35%"></i></div><span>Preparing ${escapeHTML(file.name)}…</span>`;
      await request(`/api/send?address=${encodeURIComponent(match[1])}&port=${match[2]}&filename=${encodeURIComponent(file.name)}`, {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
      await refresh(); notify('File sent to xdrop for delivery'); switchView('transfers');
    }
  } catch (error) { notify(error.message, true); }
});
document.querySelector('#refresh').addEventListener('click', refresh);
refresh();
setInterval(() => { if (document.activeElement?.tagName !== 'INPUT') refresh(); }, 2200);
