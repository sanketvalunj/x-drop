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
let routeTraceData = null;
let routeViewMode = 'path';
let routePanelMode = 'trace';
let routeStep = -1;
let routeZoom = 1;
let routeReplayTimer = null;

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
  return `<div class="device-row"><div class="device-avatar">${escapeHTML((peer.name || '?').slice(0,1).toUpperCase())}</div><div class="device-info"><strong>${escapeHTML(peer.name)}</strong><span>${escapeHTML(peer.address)} · last seen ${peer.last_seen ? timeLabel(peer.last_seen) : 'time unavailable'}</span></div><button class="button button-secondary button-small" data-send-peer="${escapeHTML(peer.address)}:${peer.port}">Send file <span>↗</span></button></div>`;
}
function incomingCard(item) {
  const pending = item.status === 'pending';
  const status = `${item.status === 'active' ? `${size(item.received)} of ${size(item.size)} received` : `${item.status}${item.verified ? ' · SHA-256 verified' : ''}`}${Number(item.resumed_bytes) > 0 ? ` · resumed ${size(item.resumed_bytes)}` : ''}`;
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
  const details = [Number(item.resumed_bytes) > 0 ? `resumed ${size(item.resumed_bytes)}` : '', item.status === 'done' && Number(item.throughput_bps) > 0 ? `${size(item.throughput_bps)}/s avg` : '', item.verified ? 'SHA-256 verified' : ''].filter(Boolean).join(' · ');
  const routeAction = direction === 'out' && item.status === 'done' ? `<button class="button button-secondary button-small" data-route-trace="${escapeHTML(`${item.peer}:${item.port}`)}" data-transfer-id="${escapeHTML(item.id)}">Trace route</button>` : '';
  return `<div class="file-card"><div class="file-icon">${mark}</div><div class="file-meta"><strong>${escapeHTML(item.filename)}</strong><span>${direction === 'out' ? `To ${escapeHTML(item.peer)}` : `From ${escapeHTML(item.sender)}`} · ${size(total)}${details ? ` · ${escapeHTML(details)}` : ''}${item.error ? ` · ${escapeHTML(item.error)}` : ''}</span>${!done ? `<div class="progress-wrap"><i style="width:${percent}%"></i></div>` : ''}</div><div class="transfer-status">${escapeHTML(status)}</div>${item.can_cancel ? `<button class="button button-danger button-small" data-cancel-transfer="${escapeHTML(item.id)}">Cancel</button>` : ''}${direction === 'out' && item.can_resume ? `<button class="button button-secondary button-small" data-resume-transfer="${escapeHTML(item.id)}">Resume</button>` : ''}${routeAction}</div>`;
}
function protocolAnalysisMarkup(trace) {
  const analysis = trace.protocol_analysis || {};
  const telemetry = analysis.telemetry || {};
  const totals = telemetry.totals || {};
  const groups = telemetry.by_type || [];
  const chunks = telemetry.chunk_sizes || [];
  const chunkCount = chunks.reduce((sum,item)=>sum + Number(item.records || 0),0);
  const chunkPayload = chunks.reduce((sum,item)=>sum + Number(item.plaintext_bytes || 0) * Number(item.records || 0),0);
  const fmt = value => Number(value || 0).toLocaleString();
  const exactBytes = value => `${fmt(value)} B`;
  const typeRows = groups.length ? groups.map(row => `<div class="protocol-type-row"><span>${escapeHTML(row.direction)}</span><strong>${escapeHTML(row.record_type)}</strong><span>${fmt(row.records)} records · ${exactBytes(row.plaintext_bytes)} payload</span><span>${exactBytes(row.ciphertext_bytes)} encrypted · ${exactBytes(row.frame_bytes)} framed</span></div>`).join('') : '<div class="protocol-empty">No encrypted records were captured for this transfer.</div>';
  const chunkRows = chunks.length ? chunks.map(row => `<div class="protocol-chunk-row"><span>${exactBytes(row.plaintext_bytes)} plaintext</span><i><b style="width:${Math.max(8,Math.round(Number(row.records)/Math.max(1,chunkCount)*100))}%"></b></i><strong>${fmt(row.records)}</strong></div>`).join('') : '<div class="protocol-empty">No file data chunks were observed.</div>';
  const recent = (telemetry.recent_records || []).slice().reverse().slice(0,16);
  const recordRows = recent.length ? recent.map(row => `<div class="protocol-record-row"><span>${fmt(row.sequence)}</span><span>${(Number(row.time_ms || 0)/1000).toFixed(3)} s</span><span class="${row.direction === 'sent' ? 'sent' : 'received'}">${row.direction === 'sent' ? '↑ Sent' : '↓ Received'}</span><strong>${escapeHTML(row.record_type)}</strong><span>${exactBytes(row.plaintext_bytes)}</span><b>${exactBytes(row.frame_bytes)}</b><em>${row.encrypted ? 'Encrypted' : 'Clear hello'}</em></div>`).join('') : '<div class="protocol-empty">Record details appear after the transfer sends or receives a protocol frame.</div>';
  const stackRows = (analysis.stack || []).map(layer => `<div class="protocol-stack-row"><span>${escapeHTML(layer.layer)}</span><strong>${escapeHTML(layer.protocol)}</strong><small>${escapeHTML(layer.detail)}</small></div>`).join('');
  const fullChunkFrame = Number(analysis.max_full_chunk_frame_bytes || 0);
  return `<div class="protocol-analysis">
    <div class="protocol-transfer-heading"><strong>${escapeHTML(trace.transfer?.filename || 'Completed transfer')}</strong><span>${size(trace.transfer?.size_bytes || 0)} · ${Number(trace.transfer?.duration_s) > 0 ? `${Number(trace.transfer.duration_s).toFixed(2)} s` : 'duration unavailable'}</span></div>
    <div class="protocol-metrics"><article><span>XDROP RECORDS</span><strong>${fmt(totals.records)}</strong></article><article><span>FILE CHUNKS SENT</span><strong>${fmt(chunkCount)}</strong><small>${exactBytes(chunkPayload)} payload</small></article><article><span>FRAMED BYTES</span><strong>${size(totals.frame_bytes)}</strong><small>${exactBytes(totals.frame_bytes)} · both directions</small></article><article><span>FRAME OVERHEAD</span><strong>${exactBytes(totals.overhead_bytes)}</strong><small>nonce + length + GCM tag</small></article></div>
    <section class="protocol-detail-section"><h3>Protocol stack</h3><div class="protocol-stack">${stackRows}</div></section>
    <section class="protocol-detail-section"><h3>Security and record format</h3><div class="protocol-facts"><div><span>Key agreement</span><strong>X25519</strong></div><div><span>Key derivation</span><strong>HKDF-SHA256</strong></div><div><span>Encryption</span><strong>AES-256-GCM</strong></div><div><span>File integrity</span><strong>SHA-256</strong></div><div><span>Hello per direction</span><strong>${analysis.handshake_hello_bytes || 37} B clear · PDIT + version + public key</strong></div><div><span>Encrypted frame layout</span><strong>${analysis.nonce_bytes || 12} B nonce + ${analysis.length_prefix_bytes || 4} B length + encrypted bytes (includes ${analysis.gcm_tag_bytes || 16} B tag)</strong></div><div><span>Frame overhead</span><strong>${analysis.encrypted_frame_overhead_bytes || 32} B per encrypted record</strong></div><div><span>Maximum xdrop chunk</span><strong>${exactBytes(analysis.chunk_size_bytes || 65536)} payload → ${exactBytes(fullChunkFrame)} framed</strong></div></div><p class="protocol-security-note">The 4-byte length prefix counts encrypted bytes, including the GCM tag. The 64 KiB chunk size is an xdrop record size. TCP can split one record across several segments or combine writes; these records are not a one-to-one list of IP packets.</p></section>
    <section class="protocol-detail-section"><h3>Observed record types</h3><div class="protocol-type-list"><div class="protocol-type-row header"><span>Direction</span><span>Record type</span><span>Count</span><span>Record bytes</span></div>${typeRows}</div></section>
    <section class="protocol-detail-section"><h3>File chunk sizes</h3><p class="protocol-section-caption">Plaintext data size inside each encrypted file_chunk record. Full chunks are up to ${size(analysis.chunk_size_bytes || 65536)}.</p><div class="protocol-chunk-list">${chunkRows}</div></section>
    <section class="protocol-detail-section"><h3>Recent observed records <small>latest ${recent.length} of ${fmt(totals.records)}</small></h3><div class="protocol-record-list"><div class="protocol-record-row header"><span>#</span><span>Time</span><span>Direction</span><span>Type</span><span>Payload</span><span>Frame</span><span>Protection</span></div>${recordRows}</div></section>
    <div class="protocol-capture-note">${escapeHTML(analysis.scope_note || '')} <b>TCP SYN/ACK, TCP segment sizes, retransmissions, IP headers and Wi-Fi/Ethernet frames are managed below this layer and are not captured by xdrop.</b></div>
  </div>`;
}
function routeTraceMarkup(trace) {
  const hops = trace.hops || [];
  const destinationHop = hops.find(hop => hop.reached);
  const nodes = [
    {kind:'source',title:'This device',subtitle:trace.local_ip ? `Detected LAN address · ${trace.local_ip}` : 'Local address unavailable',eventIndex:-1},
    ...hops.map((hop,eventIndex) => ({hop,eventIndex})).filter(entry => !entry.hop.reached).map(({hop,eventIndex}) => ({
      kind:hop.address ? 'router' : 'timeout',
      title:hop.address ? `Hop ${hop.hop}` : `Hop ${hop.hop} · no reply`,
      subtitle:hop.address || 'No router response received',
      meta:hop.latency_ms == null ? 'No reply' : `${Number(hop.latency_ms).toFixed(1)} ms RTT`,
      eventIndex,
    })),
    {kind:'destination',title:`Peer ${trace.target || ''}:${trace.port || ''}`,subtitle:trace.reached ? 'Destination replied to the trace' : 'Destination did not reply within the trace',meta:destinationHop?.latency_ms == null ? (trace.reached ? 'Reached' : 'Not reached') : `${Number(destinationHop.latency_ms).toFixed(1)} ms RTT`,eventIndex:destinationHop ? hops.findIndex(hop => hop.reached) : -1},
  ];
  const mapWidth = 680;
  const rowHeight = 102;
  const mapHeight = Math.max(440, 92 + (nodes.length - 1) * rowHeight);
  const positions = nodes.map((item,index) => ({
    x:index === 0 || index === nodes.length - 1 ? mapWidth / 2 : (index % 2 ? 180 : 500),
    y:48 + index * rowHeight,
  }));
  const paths = positions.slice(0,-1).map((point,index) => {
    const next = positions[index + 1];
    const eventIndex = nodes[index + 1].eventIndex;
    const bend = index % 2 ? -28 : 28;
    const curve = `M ${point.x} ${point.y + 33} C ${point.x + bend} ${point.y + 68}, ${next.x - bend} ${next.y - 68}, ${next.x} ${next.y - 33}`;
    const observed = eventIndex >= 0 && (routeViewMode === 'path' ? Boolean(hops[eventIndex]?.address) : eventIndex <= routeStep);
    return `<path class="route-edge ${observed ? 'observed' : ''}" d="${curve}"/>`;
  }).join('');
  const mapNodes = nodes.map((item,index) => {
    const eventIndex = item.eventIndex;
    const current = routeViewMode === 'replay' && eventIndex === routeStep;
    const passed = routeViewMode === 'replay' && eventIndex >= 0 && eventIndex < routeStep;
    const icon = item.kind === 'source' ? '⌂' : item.kind === 'destination' ? '◎' : item.kind === 'router' ? '▣' : '…';
    return `<div class="route-device ${item.kind} ${current ? 'current' : ''} ${passed ? 'passed' : ''}" style="left:${positions[index].x}px;top:${positions[index].y}px"><span class="route-device-icon">${icon}</span><div><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.subtitle)}</small></div>${item.meta ? `<b>${escapeHTML(item.meta)}</b>` : ''}</div>`;
  }).join('');
  const eventRows = hops.length ? hops.map((hop,index) => {
    const result = hop.reached ? 'Destination' : hop.address ? 'Reply' : 'No reply';
    const address = hop.address || '—';
    const latency = hop.latency_ms == null ? '—' : `${Number(hop.latency_ms).toFixed(1)} ms`;
    return `<button class="route-event ${routeViewMode === 'replay' && routeStep === index ? 'selected' : ''}" data-route-event="${index}"><span>${hop.hop}</span><span>${escapeHTML(address)}</span><span>${latency}</span><b class="${hop.address ? 'responded' : 'unanswered'}">${result}</b></button>`;
  }).join('') : `<div class="route-events-empty">No hop replies were recorded. The destination may still be reachable; networks often block traceroute probes.</div>`;
  const traceMode = routeViewMode === 'path';
  const replayControls = `<div class="route-play-controls"><button data-route-action="previous" aria-label="Previous hop" ${hops.length ? '' : 'disabled'}>◀</button><button class="play" data-route-action="toggle" aria-label="${routeReplayTimer ? 'Pause' : 'Play'}" ${hops.length ? '' : 'disabled'}>${routeReplayTimer ? 'Ⅱ' : '▶'}</button><button data-route-action="next" aria-label="Next hop" ${hops.length ? '' : 'disabled'}>▶</button></div>`;
  const notice = trace.error ? `<div class="route-error">${escapeHTML(trace.error)}</div>` : '';
  return `<div class="route-tracer-app">
    <header class="route-tracer-topbar"><div class="route-brand"><span class="route-brand-mark">⌁</span><strong>xdrop</strong><span class="route-brand-sep">/</span><span>Network route tracer</span></div><div class="route-tracer-title">Peer route · ${escapeHTML(trace.target || 'unknown')}:${trace.port || ''}</div><button class="route-top-close" data-action="close-route" aria-label="Close route tracer">×</button></header>
    <div class="route-tracer-layout"><section class="route-stage">
      <div class="route-view-switch"><button data-route-mode="path" class="${traceMode ? 'active' : ''}">◷ &nbsp;Route</button><button data-route-mode="replay" class="${!traceMode ? 'active' : ''}">◴ &nbsp;Probe replay</button></div>
      <div class="route-tool-rail"><button data-route-action="fit" title="Fit route">⌗</button><button data-route-action="zoom-in" title="Zoom in">＋</button><button data-route-action="zoom-out" title="Zoom out">−</button><button data-route-action="reset-zoom" title="Reset zoom">⤢</button></div>
      <div class="route-map-viewport"><div class="route-map" style="height:${mapHeight}px;transform:scale(${routeZoom})"><svg class="route-edges" viewBox="0 0 ${mapWidth} ${mapHeight}" aria-hidden="true">${paths}</svg>${mapNodes}</div></div>
      <div class="route-map-legend"><span><i class="source-dot"></i>This device</span><span><i class="hop-dot"></i>Responding hop</span><span><i class="no-reply-dot"></i>No reply</span><span><i class="peer-dot"></i>Peer</span></div>
    </section><aside class="route-inspector"><div class="route-inspector-head"><div><h2>${routePanelMode === 'protocol' ? 'Protocol analysis' : 'Trace panel'}</h2><span>${routePanelMode === 'protocol' ? 'Observed transfer records and protocol layers' : 'Measured hop results'}</span></div><button class="route-reset" data-route-action="reset">Reset</button></div>
      <div class="route-panel-tabs"><button data-route-panel="trace" class="${routePanelMode === 'trace' ? 'active' : ''}">Hop events</button><button data-route-panel="protocol" class="${routePanelMode === 'protocol' ? 'active' : ''}">Protocol analysis</button></div>
      ${routePanelMode === 'protocol' ? `${protocolAnalysisMarkup(trace)}${notice}` : `
      <div class="route-target-card"><span>DESTINATION</span><strong>${escapeHTML(trace.target || 'Unknown peer')}:${trace.port || ''}</strong><small>${trace.reached ? 'Peer responded' : 'Peer not reached by trace'}</small></div>
      <div class="route-play-heading"><span>Probe replay</span><small>${hops.length} ${hops.length === 1 ? 'hop recorded' : 'hops recorded'}</small></div>${replayControls}
      <div class="route-events-heading"><span>Hop events</span><span>RTT · result</span></div><div class="route-event-list">${eventRows}</div>
      ${notice}<div class="route-inspector-note">${escapeHTML(trace.note || '')}</div>`}
    </aside></div>
  </div>`;
}
function renderRouteWorkspace() {
  if (routeTraceData) document.querySelector('#route-content').innerHTML = routeTraceMarkup(routeTraceData);
}
function stopRouteReplay() {
  clearInterval(routeReplayTimer);
  routeReplayTimer = null;
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
    <section class="hero"><div class="hero-copy"><div class="hero-kicker"><i></i> Encrypted in transit</div><h2>Share files. Stay in sync.</h2><p>Send files directly to devices on your local network. Transfers are encrypted and SHA-256 checked.</p><button class="button" data-action="send"><span class="plus">＋</span> Send a file</button></div><div class="hero-art"><div class="orbit"></div><div class="orbit two"></div><i class="orbit-dot"></i><div class="art-core">⇄</div></div></section>
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
  const peerChoices = (state.peers || []).map((peer,index) => `<label class="multicast-peer"><input type="checkbox" name="multicast-peer" value="${escapeHTML(peer.address)}:${peer.port}"><span><strong>${escapeHTML(peer.name)}</strong><small>${escapeHTML(peer.address)}:${peer.port}</small></span></label>`).join('');
  return `${heading('NEW TRANSFER','Send files','Choose one or more files. Each arrives as its own encrypted transfer.')}
    <div class="card send-card"><form id="send-form"><div class="field"><label for="delivery-mode">DELIVERY MODE</label><select id="delivery-mode" class="select-input"><option value="unicast" selected>Unicast · one device</option><option value="multicast">Multicast · selected devices</option><option value="broadcast">Broadcast · all nearby devices</option></select><span class="field-hint">Group delivery uses a separate encrypted connection to each device.</span></div><div id="unicast-target"><div class="field"><label for="peer-target">SEND TO DEVICE</label><select id="peer-target" class="select-input"><option value="">${options ? 'Choose a nearby device' : 'No devices found · enter an address below'}</option>${options}</select></div><div class="manual-label">OR CONNECT DIRECTLY</div><div class="field"><label for="manual-peer">DEVICE ADDRESS</label><input id="manual-peer" placeholder="192.168.1.24:50000" value="${escapeHTML(selectedPeer)}"><span class="field-hint">Enter an IP address or hostname and port shown on the other device.</span></div></div><div class="field multicast-target" id="multicast-target" hidden><label>SELECT DEVICES</label><div class="multicast-list">${peerChoices || '<div class="multicast-empty">No nearby xdrop devices found yet.</div>'}</div></div><div class="broadcast-target" id="broadcast-target" hidden><strong>${(state.peers || []).length} nearby ${(state.peers || []).length === 1 ? 'device' : 'devices'} will receive this file</strong><span>Only xdrop devices discovered right now are included.</span></div><div class="field file-field"><label>CHOOSE FILES</label><label class="file-drop" id="drop-zone"><input id="file-input" type="file" multiple required><span class="drop-icon">↑</span><strong>Drop files here</strong><span class="drop-caption">or <b>browse files</b></span><span class="selected-file" id="selected-file">Select or drop multiple files to send them one by one.</span></label></div><div class="form-actions"><button class="button button-primary" type="submit">Send files securely <span>↗</span></button><button class="button button-quiet" type="button" data-view="overview">Cancel</button></div><div class="upload-progress" id="upload-progress"></div></form></div>`;
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
function allTransfers() {
  return [
    ...(state.incoming || []).map(item => ({...item, direction:'incoming'})),
    ...(state.outgoing || []).map(item => ({...item, direction:'outgoing'})),
  ];
}
function trafficView() {
  const transfers = allTransfers();
  const completed = transfers.filter(item => item.status === 'done');
  const activeCount = transfers.filter(item => ['active','sending','connecting'].includes(item.status)).length;
  const totalBytes = completed.reduce((sum, item) => sum + Math.max(0, Number(item.size) || 0), 0);
  const today = new Date();
  today.setHours(0,0,0,0);
  const days = Array.from({length:7}, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const daily = completed.filter(item => {
      const stamp = Number(item.started_at);
      if (!Number.isFinite(stamp) || stamp <= 0) return false;
      const transferDate = new Date(stamp * 1000);
      return `${transferDate.getFullYear()}-${transferDate.getMonth()}-${transferDate.getDate()}` === key;
    });
    return {date, label:date.toLocaleDateString(undefined,{weekday:'short'}), bytes:daily.reduce((sum,item)=>sum + Math.max(0,Number(item.size)||0),0), count:daily.length};
  });
  const peak = Math.max(0, ...days.map(day => day.bytes));
  const dailyBars = days.map(day => {
    const height = peak ? Math.round(day.bytes / peak * 100) : 0;
    return `<div class="traffic-day" title="${escapeHTML(day.date.toLocaleDateString())}: ${size(day.bytes)} across ${day.count} completed ${day.count === 1 ? 'transfer' : 'transfers'}"><div class="traffic-bar-track"><i style="height:${height}%"></i></div><strong>${day.bytes ? size(day.bytes) : '—'}</strong><span>${day.label}</span></div>`;
  }).join('');
  const byDirection = ['incoming','outgoing'].map(direction => ({
    direction,
    bytes: completed.filter(item => item.direction === direction).reduce((sum,item)=>sum + Math.max(0,Number(item.size)||0),0),
    count: completed.filter(item => item.direction === direction).length,
  }));
  const directionRows = byDirection.map(item => {
    const percent = totalBytes ? Math.round(item.bytes / totalBytes * 100) : 0;
    const name = item.direction === 'incoming' ? 'Received' : 'Sent';
    return `<div class="traffic-direction"><div class="traffic-direction-head"><strong>${name}</strong><span>${size(item.bytes)} · ${item.count} ${item.count === 1 ? 'transfer' : 'transfers'}</span></div><div class="traffic-progress"><i class="${item.direction}" style="width:${percent}%"></i></div></div>`;
  }).join('');
  const hasCompleted = completed.length > 0;
  return `${heading('NETWORK ACTIVITY','Traffic analysis','Actual completed transfers recorded by this xdrop session.')}
    <div class="traffic-note">Traffic totals use completed transfers only. History is kept in memory while this dashboard is running.</div>
    <div class="stat-grid traffic-stats"><div class="stat-card"><div class="stat-icon">⇅</div><div class="stat-text"><span>COMPLETED DATA</span><strong>${size(totalBytes)}</strong></div></div><div class="stat-card"><div class="stat-icon">✓</div><div class="stat-text"><span>COMPLETED TRANSFERS</span><strong>${completed.length}</strong></div></div><div class="stat-card"><div class="stat-icon">↻</div><div class="stat-text"><span>ACTIVE NOW</span><strong>${activeCount}</strong></div></div></div>
    <div class="traffic-grid"><section class="card traffic-chart-card"><div class="section-head"><div><h2>Completed traffic</h2><span class="traffic-caption">Completed file size by start date · last 7 days</span></div></div>${hasCompleted ? `<div class="traffic-chart">${dailyBars}</div><div class="traffic-axis"><span>Older</span><span>Today</span></div>` : `<div class="traffic-empty">No completed transfers recorded in this session yet.</div>`}</section>
    <section class="card traffic-chart-card"><div class="section-head"><div><h2>By direction</h2><span class="traffic-caption">Completed data sent and received</span></div></div>${hasCompleted ? `<div class="traffic-directions">${directionRows}</div>` : `<div class="traffic-empty">Direction totals will appear after a transfer completes.</div>`}</section></div>`;
}
function insightsView() {
  const transfers = allTransfers();
  const samples = transfers.filter(item => item.status === 'done' && Number(item.throughput_bps) > 0);
  const finished = transfers.filter(item => ['done','failed','cancelled','rejected'].includes(item.status));
  const measured = finished.filter(item => ['done','failed','cancelled'].includes(item.status));
  const completedCount = measured.filter(item => item.status === 'done').length;
  const unsuccessfulCount = measured.filter(item => ['failed','cancelled'].includes(item.status)).length;
  const resumedTransfers = transfers.filter(item => Number(item.resumed_bytes) > 0);
  const resumedBytes = resumedTransfers.reduce((sum, item) => sum + Math.max(0, Number(item.resumed_bytes) || 0), 0);
  const successRate = measured.length ? Math.round(completedCount / measured.length * 100) : null;
  const recentResults = finished.sort((a,b) => (Number(b.started_at) || 0) - (Number(a.started_at) || 0)).slice(0,5);
  const buckets = [
    {label:'Small', range:'Under 1 MB', test:n=>n < 1024**2},
    {label:'Medium', range:'1–100 MB', test:n=>n >= 1024**2 && n < 100*1024**2},
    {label:'Large', range:'100 MB+', test:n=>n >= 100*1024**2},
  ].map(bucket => {
    const matches = samples.filter(item => bucket.test(Number(item.size) || 0));
    return {...bucket, count:matches.length, avg:matches.length ? matches.reduce((sum,item)=>sum + Number(item.throughput_bps),0)/matches.length : 0};
  });
  const maxThroughput = Math.max(0,...buckets.map(bucket=>bucket.avg));
  const peers = state.discovered_peers || state.peers || [];
  const peerRows = peers.length ? peers.map(peer => {
    const quality = peer.quality;
    const online = peer.online !== false;
    return `<div class="insight-peer ${online ? '' : 'offline'}"><div class="device-avatar">${escapeHTML((peer.name || '?').slice(0,1).toUpperCase())}</div><div class="device-info"><strong>${escapeHTML(peer.name)} <small class="peer-state ${online ? 'online' : ''}">${online ? 'Online' : 'Offline'}</small></strong><span>${escapeHTML(peer.address)}:${peer.port} · last seen ${peer.last_seen ? timeLabel(peer.last_seen) : 'time unavailable'}</span>${quality ? `<small class="quality-result ${quality.last_ms == null ? 'failed' : ''}">${quality.last_ms == null ? 'Last probe failed' : `${Number(quality.last_ms).toFixed(1)} ms connect + secure probe`} · ${quality.successes}/${quality.attempts} probes succeeded (${Math.round(quality.success_rate)}%)</small>` : '<small class="quality-result">No connection probes yet</small>'}</div>${online ? `<button class="button button-quiet button-small" data-quality="${escapeHTML(peer.address)}:${peer.port}">Check</button>` : ''}</div>`;
  }).join('') : `<div class="insight-empty">No devices discovered during this session.</div>`;
  const protocol = state.protocol || {};
  const performanceRows = buckets.map(bucket => `<div class="performance-row"><div><strong>${bucket.label}</strong><span>${bucket.range} · ${bucket.count} ${bucket.count === 1 ? 'sample' : 'samples'}</span></div><div class="performance-meter"><i style="width:${maxThroughput ? Math.round(bucket.avg/maxThroughput*100) : 0}%"></i></div><b>${bucket.count ? `${size(bucket.avg)}/s` : 'No data'}</b></div>`).join('');
  const flow = [
    ['1','Secure handshake',protocol.handshake || 'X25519 + HKDF-SHA256','Fresh key for each connection'],
    ['2','Encrypted stream',protocol.cipher || 'AES-256-GCM',`${size(protocol.chunk_size || 65536)} chunks over TCP`],
    ['3','Integrity check',protocol.integrity || 'SHA-256','Receiver verifies before saving'],
    ['4','Resume if interrupted','Stable file identity','Continue partial file; verify full SHA-256 after resume'],
  ].map(step=>`<div class="protocol-step"><span>${step[0]}</span><div><strong>${escapeHTML(step[1])}</strong><b>${escapeHTML(step[2])}</b><small>${escapeHTML(step[3])}</small></div></div>`).join('');
  const resultRows = recentResults.length ? recentResults.map(item => {
    const direction = item.direction === 'incoming' ? 'Received' : 'Sent';
    const duration = Number(item.duration_s);
    const durationLabel = Number.isFinite(duration) && duration > 0 ? (duration < 60 ? `${duration.toFixed(1)} s` : `${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s`) : '—';
    const rate = item.status === 'done' && Number(item.throughput_bps) > 0 ? `${size(item.throughput_bps)}/s` : '—';
    const status = item.status === 'done' ? 'Complete' : item.status === 'rejected' ? 'Declined' : item.status === 'cancelled' ? 'Cancelled' : 'Failed';
    return `<div class="insight-result"><div class="insight-result-file"><strong>${escapeHTML(item.filename || 'File transfer')}</strong><span>${direction} · ${size(item.size)}</span></div><span class="insight-result-status ${item.status === 'failed' ? 'failed' : ''}">${status}</span><span>${durationLabel}</span><b>${rate}</b></div>`;
  }).join('') : `<div class="insight-empty">Transfer results will appear here after a transfer finishes.</div>`;
  return `${heading('NETWORK INSIGHTS','Performance & connection','Measured transfer performance, peer reachability, and the protocol used by xdrop.')}
    <div class="insight-summary"><div class="stat-card"><div class="stat-icon">✓</div><div class="stat-text"><span>TRANSFER SUCCESS</span><strong>${successRate == null ? '—' : `${successRate}%`}</strong><small>${completedCount} completed · ${unsuccessfulCount} failed or cancelled</small></div></div><div class="stat-card"><div class="stat-icon">↻</div><div class="stat-text"><span>RESUME ACTIVITY</span><strong>${size(resumedBytes)}</strong><small>${resumedTransfers.length} ${resumedTransfers.length === 1 ? 'transfer continued' : 'transfers continued'}</small></div></div><div class="stat-card"><div class="stat-icon">⇄</div><div class="stat-text"><span>RECORDED RESULTS</span><strong>${finished.length}</strong><small>Completed, failed, cancelled, or declined</small></div></div></div>
    <section class="card insight-section"><div class="section-head"><div><h2>Throughput by file size</h2><span class="traffic-caption">Average measured payload rate for completed transfers in this session</span></div></div>${samples.length ? `<div class="performance-list">${performanceRows}</div>` : `<div class="insight-empty">No completed transfer has a measured throughput yet. Send or receive a file to build a real comparison.</div>`}</section>
    <section class="card insight-section"><div class="section-head"><div><h2>Recent transfer results</h2><span class="traffic-caption">Recorded duration and measured average payload rate for the latest transfers</span></div></div>${recentResults.length ? `<div class="insight-result-list"><div class="insight-result insight-result-head"><span>Transfer</span><span>Result</span><span>Duration</span><span>Average speed</span></div>${resultRows}</div>` : resultRows}</section>
    <section class="card insight-section"><div class="section-head"><div><h2>Connection quality</h2><span class="traffic-caption">Latency includes TCP connect, secure handshake, and an encrypted probe reply. Success rate counts checks you run here.</span></div></div><div class="insight-peers">${peerRows}</div></section>
    <section class="card insight-section"><div class="section-head"><div><h2>Transfer protocol</h2><span class="traffic-caption">Actual transfer sequence and safeguards</span></div></div><div class="protocol-flow">${flow}</div></section>`;
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
    <section class="setting-card"><h3>Privacy & security</h3><p>Files are encrypted in transit and SHA-256 checked before saving. Peer identity is not authenticated, so an active LAN attacker could intercept a connection.</p><div class="security-line"><span class="security-check">✓</span><span><strong>Encrypted transport</strong><small>X25519 · AES-256-GCM · SHA-256</small></span></div></section></div>`;
}
function render() {
  if (!state) { root.innerHTML = '<div class="loading"><div><div class="spinner"></div>Connecting to your xdrop device…</div></div>'; return; }
  const names = {overview:'Overview',devices:'Devices',send:'Send a file',transfers:'Transfers',traffic:'Traffic',insights:'Insights',settings:'Settings'};
  pageName.textContent = names[currentView] || 'Overview';
  document.querySelector('#profile-name').textContent = state.device_name;
  document.querySelector('#avatar').textContent = (state.device_name || 'x').slice(0,1).toUpperCase();
  document.querySelector('#peer-count').textContent = (state.peers || []).length;
  document.querySelector('#version').textContent = state.version;
  const connection = document.querySelector('.connection');
  connection.classList.toggle('online', Boolean(state.discovery.zeroconf_active));
  document.querySelector('#connection-label').textContent = state.discovery.zeroconf_active ? 'Network active' : 'Local only';
  document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === currentView));
  root.innerHTML = ({overview,devices:devicesView,send:sendView,transfers:transfersView,traffic:trafficView,insights:insightsView,settings:settingsView}[currentView] || overview)();
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
  if (action?.dataset.action === 'close-route' || event.target.id === 'route-modal') {
    stopRouteReplay();
    document.querySelector('#route-modal').hidden = true;
    return;
  }
  const routeModeButton = event.target.closest('[data-route-mode]');
  if (routeModeButton) {
    stopRouteReplay();
    routeViewMode = routeModeButton.dataset.routeMode;
    if (routeViewMode === 'replay' && routeStep < 0 && routeTraceData?.hops?.length) routeStep = 0;
    renderRouteWorkspace();
    return;
  }
  const routeEvent = event.target.closest('[data-route-event]');
  if (routeEvent) {
    stopRouteReplay();
    routeViewMode = 'replay';
    routeStep = Number(routeEvent.dataset.routeEvent);
    renderRouteWorkspace();
    return;
  }
  const routePanel = event.target.closest('[data-route-panel]');
  if (routePanel) {
    routePanelMode = routePanel.dataset.routePanel;
    renderRouteWorkspace();
    return;
  }
  const routeControl = event.target.closest('[data-route-action]');
  if (routeControl) {
    const hops = routeTraceData?.hops || [];
    const lastHop = hops.length - 1;
    const command = routeControl.dataset.routeAction;
    if (command === 'reset') {
      stopRouteReplay(); routeViewMode = 'path'; routeStep = -1; routeZoom = 1;
    } else if (command === 'fit') {
      const viewport = document.querySelector('.route-map-viewport');
      const mapNodes = 2 + hops.filter(hop => !hop.reached).length;
      const mapHeight = Math.max(440, 92 + (mapNodes - 1) * 102);
      routeZoom = viewport ? Math.max(0.6, Math.min(1, (viewport.clientHeight - 20) / mapHeight)) : 1;
    } else if (command === 'reset-zoom') {
      routeZoom = 1;
    } else if (command === 'zoom-in') {
      routeZoom = Math.min(1.4, routeZoom + 0.1);
    } else if (command === 'zoom-out') {
      routeZoom = Math.max(0.7, routeZoom - 0.1);
    } else if (command === 'previous') {
      stopRouteReplay(); routeViewMode = 'replay'; routeStep = Math.max(0, routeStep - 1);
    } else if (command === 'next') {
      stopRouteReplay(); routeViewMode = 'replay'; routeStep = Math.min(lastHop, routeStep < 0 ? 0 : routeStep + 1);
    } else if (command === 'toggle') {
      routeViewMode = 'replay';
      if (routeReplayTimer) stopRouteReplay();
      else if (hops.length) {
        if (routeStep >= lastHop) routeStep = -1;
        routeStep++;
        routeReplayTimer = setInterval(() => {
          if (routeStep >= lastHop) { stopRouteReplay(); renderRouteWorkspace(); return; }
          routeStep++;
          renderRouteWorkspace();
        }, 850);
      }
    }
    renderRouteWorkspace();
    return;
  }
  const routeButton = event.target.closest('[data-route-trace]');
  if (routeButton) {
    stopRouteReplay();
    routeTraceData = null;
    const modal = document.querySelector('#route-modal');
    const content = document.querySelector('#route-content');
    modal.hidden = false;
    content.innerHTML = '<div class="route-loading"><i></i>Tracing the current route to the peer…</div>';
    try {
      const trace = await request('/api/route-trace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:routeButton.dataset.routeTrace,transfer_id:routeButton.dataset.transferId})});
      routeTraceData = trace;
      routeViewMode = 'path'; routeStep = -1; routeZoom = 1; routePanelMode = 'trace';
      renderRouteWorkspace();
    } catch (error) {
      content.innerHTML = `<div class="route-error">${escapeHTML(error.message)}</div>`;
    }
    return;
  }
  const qualityButton = event.target.closest('[data-quality]');
  if (qualityButton) {
    qualityButton.disabled = true;
    qualityButton.textContent = 'Checking…';
    try {
      const result = await request('/api/quality',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:qualityButton.dataset.quality})});
      await refresh();
      notify(result.last_ms == null ? `Probe failed: ${result.error || 'peer did not respond'}` : `Connect + secure probe: ${Number(result.last_ms).toFixed(1)} ms`, result.last_ms == null);
    } catch (error) {
      await refresh();
      notify(error.message, true);
    }
    return;
  }
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
  if (event.target.id === 'delivery-mode') {
    const mode = event.target.value;
    root.querySelector('#unicast-target').hidden = mode !== 'unicast';
    root.querySelector('#multicast-target').hidden = mode !== 'multicast';
    root.querySelector('#broadcast-target').hidden = mode !== 'broadcast';
  }
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
      const mode = root.querySelector('#delivery-mode').value;
      const files = [...root.querySelector('#file-input').files];
      if (!files.length) throw new Error('Choose at least one file to send');
      let endpoints = [];
      if (mode === 'unicast') {
        const target = root.querySelector('#peer-target').value || root.querySelector('#manual-peer').value.trim();
        const match = target.match(/^(.*):(\d+)$/);
        if (!match || !match[1] || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('Enter a device address and port, or choose a nearby device');
        endpoints = [`${match[1]}:${match[2]}`];
      } else if (mode === 'multicast') {
        endpoints = [...root.querySelectorAll('input[name="multicast-peer"]:checked')].map(input => input.value);
        if (!endpoints.length) throw new Error('Select at least one nearby device for multicast');
      } else if (!(state.peers || []).length) {
        throw new Error('No nearby xdrop devices are available for broadcast');
      }
      const progress = root.querySelector('#upload-progress');
      let delivered = 0, attempts = 0, cancelled = false;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        progress.innerHTML = `<div class="batch-message" id="batch-message">Preparing file ${index + 1} of ${files.length}: ${escapeHTML(file.name)}</div>`;
        const query = new URLSearchParams({mode,filename:file.name});
        endpoints.forEach(endpoint => query.append('peer', endpoint));
        const queued = await request(`/api/send?${query}`, {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
        attempts += queued.ids.length;
        progress.innerHTML = `<div class="batch-message" id="batch-message">Sending file ${index + 1} of ${files.length} to ${queued.ids.length} device${queued.ids.length === 1 ? '' : 's'}</div>`;
        const results = await waitForOutgoing(queued.ids, file.name, index + 1, files.length);
        delivered += results.filter(item => item.status === 'done').length;
        if (results.some(item => item.status === 'cancelled')) { cancelled = true; break; }
      }
      await refresh();
      notify(`${cancelled ? 'Stopped · ' : ''}${delivered} of ${attempts} file deliveries completed`, delivered < attempts);
      switchView('transfers');
    }
  } catch (error) { notify(error.message, true); }
});
async function waitForOutgoing(ids, filename, index, total) {
  while (true) {
    const latest = await request('/api/state');
    state = latest;
    const items = ids.map(id => (latest.outgoing || []).find(transfer => transfer.id === id));
    if (items.some(item => !item)) throw new Error('Could not find all outgoing transfer statuses');
    const message = root.querySelector('#batch-message');
    if (message) {
      const active = items.filter(item => !['done','failed','cancelled'].includes(item.status));
      const sending = active.find(item => item.status === 'sending') || active[0];
      if (!sending) message.textContent = `${filename} · ${items.filter(item => item.status === 'done').length}/${items.length} deliveries complete`;
      else {
        const percent = sending.size ? Math.floor(sending.sent * 100 / sending.size) : 0;
        message.textContent = sending.status === 'connecting'
          ? `Waiting for ${sending.peer} · file ${index} of ${total}`
          : `Sending file ${index} of ${total} · ${sending.peer} · ${percent}% · ${size(sending.speed_bps)}/s`;
      }
    }
    const progressBox = root.querySelector('#upload-progress');
    for (const item of items.filter(transfer => transfer.can_cancel)) {
      const cancelExists = progressBox && [...progressBox.querySelectorAll('[data-cancel-transfer]')].some(button => button.dataset.cancelTransfer === item.id);
      if (progressBox && !cancelExists) {
        progressBox.insertAdjacentHTML('beforeend', `<button class="button button-danger button-small" data-cancel-transfer="${escapeHTML(item.id)}">Cancel ${escapeHTML(item.peer)}</button>`);
      }
    }
    if (items.every(item => ['done','failed','cancelled'].includes(item.status))) return items;
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
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeQrScanner();
    stopRouteReplay();
    document.querySelector('#route-modal').hidden = true;
  }
});
refresh();
setInterval(() => {
  const focusedControl = root.contains(document.activeElement) && document.activeElement.matches('input,select,textarea');
  if (currentView !== 'send' && !focusedControl) refresh();
}, 1200);
