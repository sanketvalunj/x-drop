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
// Analyzer modal state
let analyzerTransferId = null;
let analyzerTab = 'overview';
let analyzerData = null;
let analyzerRefreshTimer = null;
let analyzerEventOffset = 0;
let analyzerEventSearch = '';
let analyzerEventCategory = '';

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
  const analyzable = !pending;
  const analyzeAttr = analyzable ? ` data-analyze-id="${escapeHTML(item.id)}" data-analyze-dir="incoming"` : '';
  const badge = analyzable ? `<span class="analyze-badge">Inspect ⊙</span>` : '';
  return `<div class="incoming-card"${analyzeAttr}><div class="device-avatar">↓</div><div class="incoming-info"><strong>${escapeHTML(item.filename)}</strong><span>${escapeHTML(item.sender)} · ${size(item.size)} · ${escapeHTML(item.address || '')}</span><span class="status-text ${item.status === 'failed' ? 'failed' : item.status === 'done' ? 'done' : ''}">` +
  `${escapeHTML(status)}</span></div>${pending ? `<div class="incoming-actions"><button class="button button-secondary" data-decision="accept" data-id="${escapeHTML(item.id)}">Accept</button><button class="button button-quiet" data-decision="reject" data-id="${escapeHTML(item.id)}">Decline</button></div>` : badge}</div>`;
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
  const analyzeAttr = ` data-analyze-id="${escapeHTML(item.id)}" data-analyze-dir="outgoing"`;
  const analyzeBadge = `<span class="analyze-badge">Inspect ⊙</span>`;
  return `<div class="file-card"${analyzeAttr}><div class="file-icon">${mark}</div><div class="file-meta"><strong>${escapeHTML(item.filename)}</strong><span>${direction === 'out' ? `To ${escapeHTML(item.peer)}` : `From ${escapeHTML(item.sender)}`} · ${size(total)}${details ? ` · ${escapeHTML(details)}` : ''}${item.error ? ` · ${escapeHTML(item.error)}` : ''}</span>${!done ? `<div class="progress-wrap"><i style="width:${percent}%"></i></div>` : ''}</div><div class="transfer-status">${escapeHTML(status)}</div>${item.can_cancel ? `<button class="button button-danger button-small" data-cancel-transfer="${escapeHTML(item.id)}">Cancel</button>` : ''}${direction === 'out' && item.can_resume ? `<button class="button button-secondary button-small" data-resume-transfer="${escapeHTML(item.id)}">Resume</button>` : ''}${routeAction}${analyzeBadge}</div>`;
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

// ============================================================
// Transfer Analyzer Modal
// ============================================================
function closeAnalyzer() {
  clearInterval(analyzerRefreshTimer);
  analyzerRefreshTimer = null;
  analyzerTransferId = null;
  analyzerData = null;
  analyzerTab = 'overview';
  analyzerEventOffset = 0;
  analyzerEventSearch = '';
  analyzerEventCategory = '';
  document.querySelector('#analyzer-modal').hidden = true;
}
function analyzerCatClass(cat) {
  const map = {connection:'az-cat-connection',handshake:'az-cat-handshake',offer:'az-cat-offer',decision:'az-cat-decision',data:'az-cat-data',progress:'az-cat-progress',integrity:'az-cat-integrity',done:'az-cat-done',error:'az-cat-error'};
  return map[cat] || 'az-cat-data';
}
function fmtTime(stamp) {
  if (!stamp) return '—';
  const d = new Date(stamp * 1000);
  return d.toLocaleTimeString(undefined, {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function fmtDuration(s) {
  if (!Number.isFinite(Number(s)) || s <= 0) return '—';
  if (s < 60) return `${Number(s).toFixed(2)} s`;
  return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
}
function renderAnalyzerModal() {
  const panel = document.querySelector('#analyzer-panel');
  if (!analyzerData || !analyzerTransferId) { panel.innerHTML = '<div class="analyzer-loading"><div class="spinner"></div><span>Loading…</span></div>'; return; }
  const d = analyzerData;
  const ov = d.overview || {};
  const dirLabel = d.direction === 'incoming' ? '↓ Incoming' : '↑ Outgoing';
  const tabs = ['overview','packets','events','protocol','route','diagnostics'];
  const tabLabels = {overview:'Overview',packets:'Packets',events:'Events',protocol:'Protocol Stack',route:'Route',diagnostics:'Diagnostics'};
  const tabsHTML = tabs.map(tab => `<button class="az-tab${analyzerTab===tab?' active':''}" data-az-tab="${tab}">${tabLabels[tab]}</button>`).join('');

  // --- OVERVIEW ---
  const bytes = ov.direction === 'receive' ? (ov.bytes_received || 0) : (ov.bytes_sent || 0);
  const throughput = Number(ov.throughput_bps || 0);
  const chunks = ov.chunks_received ?? ov.chunks_sent ?? '—';
  const statusClass = ov.status === 'done' ? 'az-good' : (ov.status === 'failed' || ov.status === 'rejected') ? 'az-bad' : '';
  const verifiedHTML = ov.verified ? `<span class="az-good">✓ SHA-256 verified</span>` : (ov.sha256 ? '<span class="az-bad">✗ Not verified</span>' : '<span>—</span>');
  const sha256Short = ov.sha256 ? `<span class="az-mono">${ov.sha256.slice(0,16)}…</span>` : '<span>—</span>';
  const overviewHTML = `
    <div class="az-stat-row">
      <div class="az-stat"><span>File size</span><strong>${size(ov.size || 0)}</strong><small>${(ov.size||0).toLocaleString()} bytes</small></div>
      <div class="az-stat"><span>Throughput</span><strong>${throughput > 0 ? size(throughput)+'/s' : '—'}</strong><small>${fmtDuration(ov.duration_s)} transfer</small></div>
      <div class="az-stat"><span>Chunks</span><strong>${chunks}</strong><small>64 KiB chunks</small></div>
    </div>
    <div class="az-overview-grid">
      <div class="az-overview-card">
        <h3>Transfer identity</h3>
        <div class="az-kv">
          <div class="az-kv-row"><span>Filename</span><strong>${escapeHTML(ov.filename || '—')}</strong></div>
          <div class="az-kv-row"><span>Status</span><strong class="${statusClass}">${escapeHTML(ov.status || '—')}</strong></div>
          <div class="az-kv-row"><span>Direction</span><strong>${escapeHTML(ov.direction || '—')}</strong></div>
          <div class="az-kv-row"><span>Transfer ID</span><strong class="az-mono">${escapeHTML(analyzerTransferId)}</strong></div>
          <div class="az-kv-row"><span>Integrity</span><div>${verifiedHTML}</div></div>
          <div class="az-kv-row"><span>SHA-256</span><div>${sha256Short}</div></div>
          ${Number(ov.resume_offset) > 0 ? `<div class="az-kv-row"><span>Resumed from</span><strong>${size(ov.resume_offset)}</strong></div>` : ''}
          ${ov.error ? `<div class="az-kv-row"><span>Error</span><strong class="az-bad">${escapeHTML(ov.error)}</strong></div>` : ''}
        </div>
      </div>
      <div class="az-overview-card">
        <h3>Network endpoints</h3>
        <div class="az-kv">
          <div class="az-kv-row"><span>Sender</span><strong>${escapeHTML(ov.sender || '—')}</strong></div>
          <div class="az-kv-row"><span>Receiver</span><strong>${escapeHTML(ov.receiver || '—')}</strong></div>
          <div class="az-kv-row"><span>Sender IP</span><strong class="az-mono">${escapeHTML(ov.sender_ip || '—')}</strong></div>
          <div class="az-kv-row"><span>Receiver IP</span><strong class="az-mono">${escapeHTML(ov.receiver_ip || '—')}</strong></div>
          <div class="az-kv-row"><span>Sender port</span><strong class="az-mono">${ov.sender_port || '—'}</strong></div>
          <div class="az-kv-row"><span>Receiver port</span><strong class="az-mono">${ov.receiver_port || '—'}</strong></div>
          <div class="az-kv-row"><span>Started</span><strong>${fmtTime(ov.started_at)}</strong></div>
          <div class="az-kv-row"><span>Finished</span><strong>${fmtTime(ov.finished_at)}</strong></div>
          <div class="az-kv-row"><span>Duration</span><strong>${fmtDuration(ov.duration_s)}</strong></div>
        </div>
      </div>
    </div>`;

  // --- EVENTS ---
  const allEvents = d.events || [];
  const filteredEvents = allEvents.filter(ev => {
    const matchSearch = !analyzerEventSearch || ev.details.toLowerCase().includes(analyzerEventSearch.toLowerCase()) || ev.category.includes(analyzerEventSearch.toLowerCase());
    const matchCat = !analyzerEventCategory || ev.category === analyzerEventCategory;
    return matchSearch && matchCat;
  });
  const totalEvents = d.events_total || 0;
  const pageSize = 25;
  const maxPage = Math.max(0, Math.ceil(filteredEvents.length / pageSize) - 1);
  const pageEvents = filteredEvents.slice(analyzerEventOffset, analyzerEventOffset + pageSize);
  const eventRows = pageEvents.length ? pageEvents.map(ev => {
    const ts = ev.timestamp ? new Date(ev.timestamp*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
    return `<div class="az-event-row"><span>${ts}</span><div><span class="az-event-cat ${analyzerCatClass(ev.category)}">${escapeHTML(ev.category)}</span></div><div class="az-event-detail">${escapeHTML(ev.details)}</div></div>`;
  }).join('') : `<div class="az-empty">No events match your filter.</div>`;
  const cats = [...new Set(allEvents.map(e => e.category))].sort();
  const catOptions = `<option value="">All categories</option>` + cats.map(c => `<option value="${escapeHTML(c)}" ${analyzerEventCategory===c?'selected':''}>${escapeHTML(c)}</option>`).join('');
  const eventsHTML = `
    <div class="az-toolbar">
      <input class="az-search" id="az-event-search" type="search" placeholder="Search events…" value="${escapeHTML(analyzerEventSearch)}">
      <select class="az-filter-select" id="az-event-cat">${catOptions}</select>
    </div>
    <div class="az-event-table">
      <div class="az-event-head"><span>Time</span><span>Category</span><span>Details</span></div>
      ${eventRows}
    </div>
    <div class="az-pagination">
      <button id="az-prev-page" ${analyzerEventOffset === 0 ? 'disabled' : ''}>← Prev</button>
      <span>Showing ${Math.min(filteredEvents.length, analyzerEventOffset + pageSize)} of ${filteredEvents.length} filtered · ${totalEvents} total events</span>
      <button id="az-next-page" ${analyzerEventOffset >= maxPage * pageSize ? 'disabled' : ''}>Next →</button>
    </div>`;

  // --- PROTOCOL STACK ---
  const stack = d.protocol_stack || [];
  const stackHTML = stack.length ? `<div class="az-stack">
    ${stack.map((layer, index) => `
      <div class="az-stack-layer">
        <div class="az-stack-num">${index + 1}</div>
        <div class="az-stack-layer-name">${escapeHTML(layer.layer)}</div>
        <div><div class="az-stack-proto">${escapeHTML(layer.protocol)}</div><div class="az-stack-detail">${escapeHTML(layer.detail)}</div></div>
        <span class="az-stack-obs ${layer.observed ? 'yes' : 'inferred'}">${layer.observed ? '✓ Observed' : '~ Inferred'}</span>
      </div>`).join('')}
    </div>
    <div class="az-empty" style="margin-top:14px;font-size:9px;color:#7a7f88">
      Application-level observations only. TCP segment boundaries, IP headers, retransmissions, and link-layer frames are managed by the OS and are not captured by xdrop. No raw packet capture is performed.
    </div>` : `<div class="az-empty">Protocol stack information is not available for this transfer.</div>`;

  // --- ROUTE tab (launches existing route modal) ---
  const netInfo = d.network || {};
  const peerEndpoint = d.direction === 'incoming'
    ? `${netInfo.remote_ip || ''}:${netInfo.remote_port || 0}`
    : `${netInfo.remote_ip || ''}:${netInfo.remote_port || 0}`;
  const routeHTML = `
    <div class="az-route-note">Click the button below to run a separate traceroute to this peer. The traceroute is a new probe — it does not replay the file transfer. Firewalls and routers may block some or all hops.</div>
    <button class="az-route-btn" data-route-trace="${escapeHTML(peerEndpoint)}" data-transfer-id="${escapeHTML(analyzerTransferId)}">⌁ Trace route to peer (${escapeHTML(netInfo.remote_ip || 'unknown')})</button>
    ${netInfo.remote_ip ? `
    <div class="az-kv" style="margin-top:8px">
      <div class="az-kv-row"><span>Local IP</span><strong class="az-mono">${escapeHTML(netInfo.local_ip || '—')}</strong></div>
      <div class="az-kv-row"><span>Remote IP</span><strong class="az-mono">${escapeHTML(netInfo.remote_ip || '—')}</strong></div>
      <div class="az-kv-row"><span>Same /24 subnet</span><strong>${netInfo.same_subnet === true ? '<span class="az-good">Yes</span>' : netInfo.same_subnet === false ? '<span class="az-bad">No</span>' : '—'}</strong></div>
    </div>` : ''}`;

  // --- DIAGNOSTICS ---
  const diagHTML = `
    <div class="az-net-grid">
      <div class="az-net-card">
        <h3>Network addresses</h3>
        <div class="az-kv">
          <div class="az-kv-row"><span>This device IP</span><strong class="az-mono">${escapeHTML(netInfo.local_ip || '—')}</strong></div>
          <div class="az-kv-row"><span>Peer IP</span><strong class="az-mono">${escapeHTML(netInfo.remote_ip || '—')}</strong></div>
          <div class="az-kv-row"><span>Local port</span><strong class="az-mono">${netInfo.local_port || '—'}</strong></div>
          <div class="az-kv-row"><span>Remote port</span><strong class="az-mono">${netInfo.remote_port || '—'}</strong></div>
        </div>
      </div>
      <div class="az-net-card">
        <h3>Topology estimate</h3>
        <div class="az-kv">
          <div class="az-kv-row"><span>Same /24 subnet</span><strong>${netInfo.same_subnet === true ? '<span class="az-good">✓ Yes (local)</span>' : netInfo.same_subnet === false ? '<span class="az-bad">No (routed)</span>' : '<span>Unavailable</span>'}</strong></div>
          <div class="az-kv-row"><span>Note</span><strong>IP headers and routing are OS-managed; only application-layer data is observed by xdrop.</strong></div>
        </div>
        ${netInfo.remote_ip ? `<button class="az-net-diag-btn" id="az-run-diag" data-diag-endpoint="${escapeHTML(`${netInfo.remote_ip}:${netInfo.remote_port || 0}`)}">▶ Run connection probe</button>` : ''}
        <div id="az-diag-result"></div>
      </div>
    </div>`;

  // Build section content
  const tel = d.telemetry;
  const pkTotals = tel?.totals || {};
  const packetsHTML = tel ? `
    <div class="az-stat-row">
      <div class="az-stat"><span>Packets (records)</span><strong>${fmtNum(pkTotals.records)}</strong><small>${fmtNum(pkTotals.sent_records)} sent · ${fmtNum(pkTotals.received_records)} received</small></div>
      <div class="az-stat"><span>Encryption + framing</span><strong>${fmtNum(pkTotals.overhead_bytes)} B</strong><small>${pct(pkTotals.overhead_bytes, pkTotals.frame_bytes)} of ${size(pkTotals.frame_bytes || 0)}</small></div>
      <div class="az-stat"><span>TCP segments</span><strong>${tel.tcp?.delta_segs_out != null ? fmtNum((tel.tcp.delta_segs_out || 0) + (tel.tcp.delta_segs_in || 0)) : fmtNum(pkTotals.tcp_segments_est)}</strong><small>${tel.tcp?.delta_segs_out != null ? 'measured by kernel' : `estimated · MSS ${fmtNum(tel.mss)} B`}</small></div>
    </div>
    ${typeTable(tel)}
    <div class="pk-card"><h3>Throughput timeline</h3>${timelineChart(tel.timeline)}</div>
    <button class="az-route-btn" data-open-packets="${escapeHTML(analyzerTransferId)}">▥ Open the packet inspector for this transfer</button>`
    : `<div class="az-empty">No packet data was recorded for this transfer.</div>`;
  const sections = {overview:overviewHTML, packets:packetsHTML, events:eventsHTML, protocol:stackHTML, route:routeHTML, diagnostics:diagHTML};
  panel.innerHTML = `
    <div class="az-header">
      <div class="az-header-left">
        <span class="az-badge ${d.direction === 'incoming' ? 'in' : ''}">${dirLabel}</span>
        <div><div class="az-title" id="analyzer-title">${escapeHTML(ov.filename || analyzerTransferId)}</div><div class="az-subtitle">Transfer · ${escapeHTML(ov.status || '')} · ${size(ov.size || 0)}</div></div>
      </div>
      <button class="az-close" id="az-close-btn" aria-label="Close analyzer">×</button>
    </div>
    <div class="az-tabs">${tabsHTML}</div>
    <div class="az-body">
      ${tabs.map(tab => `<div class="az-section${analyzerTab===tab?' visible':''}" id="az-section-${tab}">${sections[tab]}</div>`).join('')}
    </div>`;

  // Wire up in-modal events
  document.querySelector('#az-close-btn').addEventListener('click', closeAnalyzer);
  panel.querySelectorAll('.az-tab').forEach(btn => btn.addEventListener('click', () => {
    analyzerTab = btn.dataset.azTab;
    panel.querySelectorAll('.az-tab').forEach(t => t.classList.toggle('active', t.dataset.azTab === analyzerTab));
    panel.querySelectorAll('.az-section').forEach(s => s.classList.toggle('visible', s.id === `az-section-${analyzerTab}`));
  }));
  const searchInput = panel.querySelector('#az-event-search');
  if (searchInput) searchInput.addEventListener('input', () => { analyzerEventSearch = searchInput.value; analyzerEventOffset = 0; renderAnalyzerModal(); });
  const catSelect = panel.querySelector('#az-event-cat');
  if (catSelect) catSelect.addEventListener('change', () => { analyzerEventCategory = catSelect.value; analyzerEventOffset = 0; renderAnalyzerModal(); });
  const prevBtn = panel.querySelector('#az-prev-page');
  if (prevBtn) prevBtn.addEventListener('click', () => { analyzerEventOffset = Math.max(0, analyzerEventOffset - pageSize); renderAnalyzerModal(); });
  const nextBtn = panel.querySelector('#az-next-page');
  if (nextBtn) nextBtn.addEventListener('click', () => { analyzerEventOffset = Math.min(maxPage * pageSize, analyzerEventOffset + pageSize); renderAnalyzerModal(); });
  const runDiagBtn = panel.querySelector('#az-run-diag');
  if (runDiagBtn) runDiagBtn.addEventListener('click', async () => {
    const ep = runDiagBtn.dataset.diagEndpoint;
    const resultDiv = panel.querySelector('#az-diag-result');
    if (!resultDiv) return;
    resultDiv.innerHTML = '<div class="az-empty">Running probe…</div>';
    try {
      const result = await request('/api/network-diag', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({endpoint:ep})});
      resultDiv.innerHTML = `<div class="az-diag-result">
        <strong>Local IP:</strong> ${escapeHTML(result.local_ip || '—')}<br>
        <strong>Remote IP:</strong> ${escapeHTML(result.remote_ip || '—')}<br>
        <strong>Subnet:</strong> ${escapeHTML(result.same_subnet_note || '—')}<br>
        <strong>Probe latency:</strong> ${result.probe_ms != null ? `${Number(result.probe_ms).toFixed(1)} ms (connect + handshake + round-trip)` : `Failed: ${escapeHTML(result.probe_error || 'unknown error')}`}<br>
        <small style="color:#7a7f88">${escapeHTML(result.note || '')}</small>
      </div>`;
    } catch (error) { resultDiv.innerHTML = `<div class="az-diag-result az-bad">${escapeHTML(error.message)}</div>`; }
  });
}
async function analyzeTransfer(transferId) {
  analyzerTransferId = transferId;
  analyzerData = null;
  analyzerTab = 'overview';
  analyzerEventOffset = 0;
  analyzerEventSearch = '';
  analyzerEventCategory = '';
  const modal = document.querySelector('#analyzer-modal');
  const panel = document.querySelector('#analyzer-panel');
  modal.hidden = false;
  panel.innerHTML = '<div class="analyzer-loading"><div class="spinner"></div><span>Loading transfer analysis…</span></div>';
  try {
    analyzerData = await request(`/api/analyzer/${encodeURIComponent(transferId)}`);
    renderAnalyzerModal();
    clearInterval(analyzerRefreshTimer);
    const activeStatuses = new Set(['active','sending','connecting','pending']);
    if (activeStatuses.has(analyzerData?.overview?.status)) {
      analyzerRefreshTimer = setInterval(async () => {
        if (document.querySelector('#analyzer-modal')?.hidden) { clearInterval(analyzerRefreshTimer); return; }
        try {
          const fresh = await request(`/api/analyzer/${encodeURIComponent(analyzerTransferId)}`);
          analyzerData = fresh;
          if (!activeStatuses.has(fresh?.overview?.status)) clearInterval(analyzerRefreshTimer);
          renderAnalyzerModal();
        } catch (_) {}
      }, 2000);
    }
  } catch (error) {
    panel.innerHTML = `<div class="az-header"><button class="az-close" id="az-close-btn">×</button></div><div class="az-body"><div class="az-empty"><strong>Could not load analysis</strong><br>${escapeHTML(error.message)}</div></div>`;
    document.querySelector('#az-close-btn')?.addEventListener('click', closeAnalyzer);
  }
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
const VIA_LABEL = {mdns:'mDNS', broadcast:'Broadcast', scan:'Scan', direct:'Direct'};
function viaBadges(via = '') {
  return String(via || '').split('+').filter(Boolean).map(v => `<span class="via-badge via-${escapeHTML(v)}">${escapeHTML(VIA_LABEL[v] || v)}</span>`).join('');
}
function discoveryCard() {
  const d = state.discovery || {};
  const methods = d.methods || {};
  const beacon = d.beacon_stats || {};
  const scan = d.scan || {};
  const ifaces = d.interfaces || [];
  const scanLabel = scan.running ? 'Scanning…' : scan.last_finished ? `Last scan ${timeLabel(scan.last_finished)} · ${scan.found || 0} found in ${scan.hosts || 0} probes` : 'Runs automatically if nothing is found';
  const method = (key, title, active, detail) => `<div class="disc-method ${active ? 'on' : 'off'}"><div class="disc-method-head"><i></i><strong>${title}</strong><span>${methods[key] || 0} found</span></div><small>${detail}</small></div>`;
  return `<section class="card disc-card"><div class="section-head"><div><h2>How devices are found</h2><span class="traffic-caption">Three methods run together. Phone hotspots often block mDNS, so broadcast and scan keep working.</span></div><button class="button button-secondary button-small" data-action="scan-network" ${scan.running ? 'disabled' : ''}>${scan.running ? 'Scanning…' : '⌕ Scan network now'}</button></div>
    <div class="disc-methods">
      ${method('mdns','mDNS / Bonjour', d.zeroconf_active, d.zeroconf_active ? (d.registered ? 'Advertising _xdrop._tcp on every interface' : 'Browsing only, registration failed') : escapeHTML(d.last_error || 'Unavailable'))}
      ${method('broadcast','UDP broadcast', d.beacon_active, d.beacon_active ? `Port ${d.beacon_port} · ${beacon.sent || 0} hellos sent · ${beacon.received || 0} heard${d.beacon_bound ? '' : ' · port busy, replies only'}` : 'Unavailable on this network')}
      ${method('scan','Subnet scan', true, escapeHTML(scanLabel))}
    </div>
    <div class="disc-ifaces">${ifaces.length ? ifaces.map(i => `<span><b>${escapeHTML(i.ip)}</b>/${i.prefix} · ${escapeHTML(i.name)}</span>`).join('') : '<span>No network interface detected. Connect to Wi-Fi or a hotspot.</span>'}</div>
    ${!(state.peers || []).length ? `<div class="disc-help"><strong>Still nothing?</strong> Both devices must be on the same hotspot. On Windows, allow Python on <b>Public</b> networks too (hotspots are usually Public). Or type the other device’s IP in “Connect by IP”: it is shown on that device’s Send page.</div>` : ''}
  </section>`;
}
function devicesView() {
  const peers = state.peers || [];
  return `${heading('NETWORK','Devices','Choose a nearby device or connect directly with an IP address.')}
    <div class="copy-address-row"><div><span>This device · other devices can type this</span><strong>${escapeHTML(state.local_ip ? `${state.local_ip}:${state.port}` : 'Address not detected')}</strong></div><button class="button button-quiet button-small" data-copy-address="${escapeHTML(state.local_ip ? `${state.local_ip}:${state.port}` : '')}" ${state.local_ip ? '' : 'disabled'}>Copy</button></div>
    ${discoveryCard()}
    <section class="connect-card"><div class="connect-copy"><div class="eyebrow">DIRECT CONNECTION</div><h2>Connect by IP</h2><p>Enter the address shown in xdrop on the other device.</p></div><form id="connect-form"><label class="sr-only" for="connect-address">Device IP address and port</label><div class="connect-controls"><input id="connect-address" placeholder="192.168.43.24" autocomplete="off" required><button class="button button-primary" type="submit">Continue <span>→</span></button></div><span class="connect-error" id="connect-error" aria-live="polite"></span><span class="field-hint">Example: 192.168.43.24 or 192.168.43.24:47474 · the port is optional.</span></form></section>
    <div class="section-head device-section-head"><h2>Nearby devices</h2><span class="field-hint">${peers.length} available</span></div>${peers.length ? `<div class="device-grid">${peers.map(peer => `<article class="device-card"><div class="device-card-head"><div class="device-avatar">${escapeHTML((peer.name || '?').slice(0,1).toUpperCase())}</div><div><strong>${escapeHTML(peer.name)}</strong><div class="via-row">${viaBadges(peer.via)}</div></div></div><div class="device-address">${escapeHTML(peer.address)}:${peer.port}</div><button class="button button-secondary" data-send-peer="${escapeHTML(peer.address)}:${peer.port}">Send a file <span>↗</span></button></article>`).join('')}</div>` : `<div class="card empty"><div class="empty-mark">◉</div><strong>No nearby devices yet</strong>Keep xdrop open on the other device. Discovery keeps trying every few seconds.</div>`}`;
}
function sendView(selectedPeer = '') {
  const options = (state.peers || []).map(peer => `<option value="${escapeHTML(peer.address)}:${peer.port}" ${selectedPeer === `${peer.address}:${peer.port}` ? 'selected' : ''}>${escapeHTML(peer.name)} · ${escapeHTML(peer.address)}:${peer.port}</option>`).join('');
  const peerChoices = (state.peers || []).map((peer,index) => `<label class="multicast-peer"><input type="checkbox" name="multicast-peer" value="${escapeHTML(peer.address)}:${peer.port}"><span><strong>${escapeHTML(peer.name)}</strong><small>${escapeHTML(peer.address)}:${peer.port}</small></span></label>`).join('');
  return `${heading('NEW TRANSFER','Send files','Choose one or more files. Each arrives as its own encrypted transfer.')}
    <div class="copy-address-row"><div><span>This device · share this address</span><strong>${escapeHTML(state.local_ip ? `${state.local_ip}:${state.port}` : 'Address not detected')}</strong></div><button class="button button-quiet button-small" data-copy-address="${escapeHTML(state.local_ip ? `${state.local_ip}:${state.port}` : '')}" ${state.local_ip ? '' : 'disabled'}>Copy</button></div>${!(state.peers || []).length && Date.now()/1000 - state.started_at >= 10 ? '<div class="empty"><strong>No devices found after 10 seconds</strong>Wi-Fi may block mDNS or isolate clients, common on college networks. Try a phone hotspot or connect by IP.</div>' : ''}
    <div class="card send-card"><form id="send-form"><div class="field"><label for="delivery-mode">DELIVERY MODE</label><select id="delivery-mode" class="select-input"><option value="unicast" selected>Unicast · one device</option><option value="multicast">Multicast · selected devices</option><option value="broadcast">Broadcast · all nearby devices</option></select><span class="field-hint">Group delivery uses a separate encrypted connection to each device.</span></div><div id="unicast-target"><div class="field"><label for="peer-target">SEND TO DEVICE</label><select id="peer-target" class="select-input"><option value="">${options ? 'Choose a nearby device' : 'No devices found · enter an address below'}</option>${options}</select></div><div class="manual-label">OR CONNECT DIRECTLY</div><div class="field"><label for="manual-peer">DEVICE ADDRESS</label><input id="manual-peer" placeholder="192.168.1.24" value="${escapeHTML(selectedPeer)}"><span class="field-hint">Enter the other device’s IP; the default receiver port is used automatically.</span></div></div><div class="field multicast-target" id="multicast-target" hidden><label>SELECT DEVICES</label><div class="multicast-list">${peerChoices || '<div class="multicast-empty">No nearby xdrop devices found yet.</div>'}</div></div><div class="broadcast-target" id="broadcast-target" hidden><strong>${(state.peers || []).length} nearby ${(state.peers || []).length === 1 ? 'device' : 'devices'} will receive this file</strong><span>Only xdrop devices discovered right now are included.</span></div><div class="field file-field"><label>CHOOSE FILES</label><label class="file-drop" id="drop-zone"><input id="file-input" type="file" multiple required><span class="drop-icon">↑</span><strong>Drop files here</strong><span class="drop-caption">or <b>browse files</b></span><span class="selected-file" id="selected-file">Select or drop multiple files to send them one by one.</span></label></div><div class="form-actions"><button class="button button-primary" type="submit">Send files securely <span>↗</span></button><button class="button button-quiet" type="button" data-view="overview">Cancel</button></div><div class="upload-progress" id="upload-progress"></div></form></div>`;
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
// ---------------------------------------------------------------------------
// Packets: live network analyzer (records on the wire, encapsulation, path)
// ---------------------------------------------------------------------------
const pk = {transfer:'', seq:null, type:'', dir:'', paused:false, link:'wifi', live:null, detail:null, paths:{}, error:''};
const TYPE_INFO = {
  handshake_hello:{label:'HELLO', cls:'hs', about:'Key exchange (X25519). Sent in clear: 4-byte magic “PDIT”, 1-byte version, 32-byte public key. Contains no secret.'},
  offer:{label:'OFFER', cls:'ctl', about:'Sender proposes a file: name, size, SHA-256, resume id.'},
  response:{label:'RESPONSE', cls:'ctl', about:'Receiver accepts or rejects; includes the resume offset.'},
  file_chunk:{label:'DATA', cls:'data', about:'One 64 KiB piece of the file, encrypted with AES-256-GCM.'},
  done:{label:'DONE', cls:'ctl', about:'Sender finished; carries the SHA-256 of the whole file.'},
  ack:{label:'ACK', cls:'ok', about:'Receiver confirms the SHA-256 matched (or reports a failure).'},
  probe:{label:'PROBE', cls:'ctl', about:'Reachability / latency check.'},
  probe_ack:{label:'PROBE-ACK', cls:'ok', about:'Answer to a probe.'},
};
const typeInfo = type => TYPE_INFO[type] || {label:String(type || 'RECORD').toUpperCase(), cls:'ctl', about:'xdrop control record.'};
const fmtNum = n => Number(n || 0).toLocaleString();
const pct = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';
function encap(frame, mss, link) {
  mss = Math.max(88, Number(mss) || 1460);
  const tcpH = mss <= 1460 ? Math.max(20, 1500 - 20 - mss) : 20;
  const segs = Math.max(1, Math.ceil(frame / mss));
  const linkH = link === 'wifi' ? 38 : 18;
  return {mss, tcpH, ipH:20, linkH, segs, last: frame - (segs - 1) * mss, wire: frame + segs * (tcpH + 20 + linkH)};
}
function recordInfo(r) {
  if (r.record_type === 'handshake_hello') return 'Public key exchange (unencrypted, no secrets)';
  if (r.record_type === 'file_chunk') return `Encrypted file data · ${fmtNum(r.plaintext_bytes)} B of file`;
  if (r.control) {
    try {
      const m = JSON.parse(r.control);
      if (m.type === 'offer') return `File “${m.filename}” · ${size(m.size)} · sha256 ${String(m.sha256 || '').slice(0,10)}…`;
      if (m.type === 'response') return m.accept ? `Accepted · resume offset ${fmtNum(m.offset || 0)}` : `Rejected · ${m.reason || ''}`;
      if (m.type === 'done') return `Finished · sha256 ${String(m.sha256 || '').slice(0,16)}…`;
      if (m.type === 'ack') return m.ok ? 'Integrity verified ✓' : `Verification failed · ${m.reason || ''}`;
      return m.type || 'control';
    } catch (_) {}
  }
  return typeInfo(r.record_type).about;
}
function pkRows() {
  let rows;
  if (pk.transfer) rows = pk.detail?.telemetry?.recent_records || [];
  else rows = [...(pk.live?.feed || [])].reverse();
  return rows.filter(r => (!pk.type || r.record_type === pk.type) && (!pk.dir || r.direction === pk.dir));
}
async function loadPackets() {
  try {
    pk.live = await request('/api/packets');
    if (pk.transfer) {
      pk.detail = await request(`/api/analyzer/${encodeURIComponent(pk.transfer)}?limit=1`);
      const ip = pk.detail?.network?.remote_ip;
      if (ip && !pk.paths[ip]) {
        pk.paths[ip] = {loading:true};
        request(`/api/path?ip=${encodeURIComponent(ip)}`).then(p => { pk.paths[ip] = p; if (currentView === 'packets') render(); }).catch(e => { pk.paths[ip] = {error:e.message}; });
      }
    } else pk.detail = null;
    pk.error = '';
  } catch (error) { pk.error = error.message; }
}
function hexBytes(hex, cls, title) {
  if (!hex) return '';
  return `<span class="hx ${cls}" title="${escapeHTML(title)}">${hex.match(/.{1,2}/g).join(' ')}</span>`;
}
function hexView(r) {
  if (r.raw_hex) {
    const h = r.raw_hex;
    return `<div class="hex-line">${hexBytes(h.slice(0,8),'hx-magic','Magic “PDIT” (4 B)')} ${hexBytes(h.slice(8,10),'hx-len','Protocol version (1 B)')} ${hexBytes(h.slice(10),'hx-key','X25519 public key (32 B)')}</div>
      <div class="hex-legend"><span class="hx-magic">magic “PDIT”</span><span class="hx-len">version</span><span class="hx-key">public key</span></div>`;
  }
  if (!r.header_hex) return '<div class="az-empty">No byte data recorded for this record.</div>';
  const len = parseInt(r.header_hex.slice(24), 16);
  const body = Math.max(0, r.ciphertext_bytes - 16);
  const preview = (r.cipher_preview_hex || '').slice(0, Math.min(24, body) * 2);
  const hidden = Math.max(0, body - 24);
  return `<div class="hex-line">${hexBytes(r.header_hex.slice(0,24),'hx-nonce','Nonce, random per frame (12 B)')} ${hexBytes(r.header_hex.slice(24),'hx-len',`Length = ${len} (4 B, big-endian)`)} ${hexBytes(preview,'hx-ct','Ciphertext (encrypted data)')} ${hidden ? `<span class="hx-gap">… ${fmtNum(hidden)} more encrypted bytes …</span> ` : ''}${hexBytes(r.tag_hex,'hx-tag','GCM authentication tag (16 B)')}</div>
    <div class="hex-legend"><span class="hx-nonce">nonce 12 B</span><span class="hx-len">length 4 B = ${fmtNum(len)}</span><span class="hx-ct">ciphertext</span><span class="hx-tag">GCM tag 16 B</span></div>`;
}
function packetDetail(r, mss, path) {
  if (!r) return `<div class="pk-detail empty-detail"><strong>Select a packet</strong><span>Click any row to see how it is built, layer by layer.</span></div>`;
  const info = typeInfo(r.record_type);
  const e = encap(r.frame_bytes, mss, pk.link);
  const encrypted = r.encrypted;
  const tag = encrypted ? 16 : 0, hdr = encrypted ? 16 : 0;
  const data = encrypted ? r.plaintext_bytes : r.frame_bytes;
  const tcpTotal = e.segs * e.tcpH, ipTotal = e.segs * 20, linkTotal = e.segs * e.linkH;
  const parts = [
    ['Data', data, 'b-data'], ['GCM tag', tag, 'b-tag'], ['xdrop header', hdr, 'b-hdr'],
    ['TCP headers', tcpTotal, 'b-tcp'], ['IP headers', ipTotal, 'b-ip'], [pk.link === 'wifi' ? 'Wi-Fi headers' : 'Ethernet headers', linkTotal, 'b-link'],
  ].filter(p => p[1] > 0);
  const bar = `<div class="byte-bar">${parts.map(p => `<i class="${p[2]}" style="flex:${Math.max(p[1], e.wire * 0.012)}" title="${p[0]}: ${fmtNum(p[1])} B"></i>`).join('')}</div><div class="byte-legend">${parts.map(p => `<span><i class="${p[2]}"></i>${p[0]} <b>${fmtNum(p[1])} B</b></span>`).join('')}</div>`;
  const [srcIp, srcPort] = String(r.src || ':').split(':');
  const [dstIp, dstPort] = String(r.dst || ':').split(':');
  const mac = path?.peer_mac;
  const stages = [
    {n:'7', layer:'Application', title: r.record_type === 'file_chunk' ? 'File bytes read from disk' : r.record_type === 'handshake_hello' ? 'Handshake hello' : 'JSON control message', bytes: data, add: null, note: info.about},
    ...(encrypted ? [
      {n:'6', layer:'Encryption', title:'AES-256-GCM encrypt', bytes: r.ciphertext_bytes, add:`+${tag} B tag`, note:'Ciphertext is the same length as the data plus a 16-byte authentication tag that detects tampering.'},
      {n:'5', layer:'xdrop framing', title:'Add frame header', bytes: r.frame_bytes, add:`+${hdr} B`, note:'12-byte random nonce + 4-byte length so the receiver knows where this record ends in the TCP stream.'},
    ] : []),
    {n:'4', layer:'Transport · TCP', title:`Split into ${fmtNum(e.segs)} segment${e.segs === 1 ? '' : 's'}`, bytes: r.frame_bytes + tcpTotal, add:`+${e.tcpH} B × ${e.segs}`, note:`Max ${fmtNum(e.mss)} B of payload per segment (MSS). Ports ${srcPort || '?'} → ${dstPort || '?'}. TCP numbers every byte so lost segments are re-sent.`},
    {n:'3', layer:'Network · IPv4', title:`${fmtNum(e.segs)} IP packet${e.segs === 1 ? '' : 's'}`, bytes: r.frame_bytes + tcpTotal + ipTotal, add:`+20 B × ${e.segs}`, note:`${srcIp || '?'} → ${dstIp || '?'} · protocol 6 (TCP) · each packet ≤ 1500 B MTU.`},
    {n:'2', layer: pk.link === 'wifi' ? 'Link · Wi-Fi 802.11' : 'Link · Ethernet', title:`${fmtNum(e.segs)} frame${e.segs === 1 ? '' : 's'} on the air`, bytes: e.wire, add:`+${e.linkH} B × ${e.segs}`, note: mac ? `Destination MAC ${mac} (from the ARP table).` : 'Addressed by MAC address; the access point forwards it to the peer.'},
  ];
  const stageHTML = stages.map((st, i) => `<div class="stage"><div class="stage-num">L${st.n}</div><div class="stage-body"><div class="stage-head"><span>${escapeHTML(st.layer)}</span><b>${fmtNum(st.bytes)} B</b>${st.add ? `<em>${escapeHTML(st.add)}</em>` : ''}</div><strong>${escapeHTML(st.title)}</strong><small>${escapeHTML(st.note)}</small></div></div>${i < stages.length - 1 ? '<div class="stage-arrow">↓</div>' : ''}`).join('');
  const segShow = Math.min(e.segs, 48);
  const segs = Array.from({length: segShow}, (_, i) => {
    const payload = i === e.segs - 1 ? e.last : e.mss;
    return `<i style="flex:${payload}" title="Segment ${i + 1}: ${fmtNum(payload)} B payload + ${e.tcpH + 20 + e.linkH} B headers"><span>${i + 1}</span></i>`;
  }).join('');
  let control = '';
  if (r.control) { try { control = JSON.stringify(JSON.parse(r.control), null, 2); } catch (_) { control = r.control; } }
  return `<div class="pk-detail">
    <div class="pk-detail-head"><span class="pk-type ${info.cls}">${info.label}</span><div><strong>Packet #${r.sequence} · ${r.direction === 'sent' ? 'sent ↑' : 'received ↓'}</strong><small>${escapeHTML(r.src || '?')} → ${escapeHTML(r.dst || '?')} · t = ${Number(r.time_ms || 0).toFixed(1)} ms</small></div></div>
    <div class="pk-kpis"><div><span>Data</span><b>${fmtNum(data)} B</b></div><div><span>Frame</span><b>${fmtNum(r.frame_bytes)} B</b></div><div><span>On the wire*</span><b>${fmtNum(e.wire)} B</b></div><div><span>Efficiency</span><b>${pct(data, e.wire)}</b></div></div>
    <h4>How this packet is built</h4>${bar}
    <div class="stages">${stageHTML}</div>
    <h4>TCP segmentation* <small>${fmtNum(e.segs)} segment${e.segs === 1 ? '' : 's'} of ≤ ${fmtNum(e.mss)} B${e.segs > segShow ? ` · first ${segShow} shown` : ''}</small></h4><div class="seg-ladder">${segs}</div>
    <h4>Real bytes on the wire</h4>${hexView(r)}
    ${control ? `<h4>Decoded control message</h4><pre class="pk-json">${escapeHTML(control)}</pre>` : ''}
    <p class="pk-foot">* TCP/IP/link sizes are calculated from the measured MSS and standard header sizes. TCP is a byte stream, so the OS may merge small records or split large ones differently. Record sizes, timings, header bytes and the kernel TCP counters are measured.</p>
  </div>`;
}
function timelineChart(timeline) {
  if (!timeline?.length) return '<div class="traffic-empty">No timeline yet.</div>';
  const w = 640, h = 150, pad = 26;
  const maxT = Math.max(...timeline.map(b => b.t), 0.25);
  const peak = Math.max(...timeline.map(b => (b.sent_bytes || 0) + (b.received_bytes || 0)), 1);
  const bw = Math.min(14, Math.max(2, (w - pad * 2) / ((maxT / 0.25) + 2) - 1));
  const bars = timeline.map(b => {
    const x = pad + b.t / (maxT + 0.25) * (w - pad * 2);
    const hs = (b.sent_bytes || 0) / peak * (h - pad * 1.6), hr = (b.received_bytes || 0) / peak * (h - pad * 1.6);
    return `<rect class="tl-sent" x="${x.toFixed(1)}" y="${(h - pad - hs).toFixed(1)}" width="${bw.toFixed(1)}" height="${hs.toFixed(1)}"><title>${b.t}s · sent ${size(b.sent_bytes || 0)}</title></rect><rect class="tl-recv" x="${x.toFixed(1)}" y="${(h - pad - hs - hr).toFixed(1)}" width="${bw.toFixed(1)}" height="${hr.toFixed(1)}"><title>${b.t}s · received ${size(b.received_bytes || 0)}</title></rect>`;
  }).join('');
  return `<svg class="timeline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" class="tl-axis"/>${bars}<text x="${pad}" y="${h - 8}">0 s</text><text x="${w - pad}" y="${h - 8}" text-anchor="end">${(maxT + 0.25).toFixed(2)} s</text><text x="${pad}" y="14">peak ${size(peak)} / 250 ms</text></svg><div class="byte-legend"><span><i class="tl-sent"></i>Sent</span><span><i class="tl-recv"></i>Received</span></div>`;
}
function tcpCard(tel) {
  const tcp = tel?.tcp;
  if (!tcp?.last) return `<div class="pk-card"><h3>Kernel TCP counters</h3><p class="pk-muted">This operating system does not expose per-connection TCP counters to Python (Windows). Segment counts are estimated from the MSS instead.</p><div class="az-kv"><div class="az-kv-row"><span>MSS</span><strong>${fmtNum(tel?.mss)} B ${tel?.mss_measured ? '(measured)' : '(default)'}</strong></div></div></div>`;
  const l = tcp.last;
  const row = (k, v) => v == null || v === '' ? '' : `<div class="az-kv-row"><span>${k}</span><strong>${v}</strong></div>`;
  return `<div class="pk-card"><h3>Kernel TCP counters <span class="measured">measured</span></h3><p class="pk-muted">Read from ${escapeHTML(l.source)} for this connection.</p><div class="az-kv">
    ${row('MSS (max segment)', `${fmtNum(l.snd_mss)} B`)}
    ${row('Round-trip time', l.rtt_ms != null ? `${Number(l.rtt_ms).toFixed(2)} ms ± ${Number(l.rttvar_ms || 0).toFixed(2)}` : null)}
    ${row('TCP segments sent', tcp.delta_segs_out != null ? fmtNum(tcp.delta_segs_out) : null)}
    ${row('TCP segments received', tcp.delta_segs_in != null ? fmtNum(tcp.delta_segs_in) : null)}
    ${row('Retransmissions', tcp.delta_total_retrans != null ? fmtNum(tcp.delta_total_retrans) : null)}
    ${row('Bytes acknowledged', tcp.delta_bytes_acked != null ? size(tcp.delta_bytes_acked) : null)}
    ${row('Congestion window', l.snd_cwnd != null ? `${fmtNum(l.snd_cwnd)} segments` : null)}
    ${row('Path MTU', l.pmtu ? `${fmtNum(l.pmtu)} B` : null)}
  </div></div>`;
}
function pathCard(path, net) {
  if (!net?.remote_ip) return '';
  if (!path || path.loading) return `<div class="pk-card"><h3>Network path</h3><p class="pk-muted">Looking up gateway and ARP table…</p></div>`;
  if (path.error) return `<div class="pk-card"><h3>Network path</h3><p class="pk-muted">${escapeHTML(path.error)}</p></div>`;
  const icon = {source:'⌂', switch:'⇌', router:'▣', destination:'◎'};
  return `<div class="pk-card"><h3>Network path</h3><p class="pk-muted">${path.same_link ? 'Both devices are on the same subnet: one hop through the access point, no router.' : 'Different subnets: packets are routed.'}</p>
    <div class="path-hops">${(path.hops || []).map((h, i) => `<div class="path-hop ${h.kind}"><span>${icon[h.kind] || '•'}</span><div><strong>${escapeHTML(h.title)}</strong><b>${escapeHTML(h.ip || '—')}</b><small>${escapeHTML(h.detail || '')}</small></div></div>${i < path.hops.length - 1 ? '<div class="path-link"></div>' : ''}`).join('')}</div>
    <button class="button button-quiet button-small" data-route-trace="${escapeHTML(`${net.remote_ip}:${net.remote_port || 0}`)}" data-transfer-id="${escapeHTML(pk.transfer)}">⌁ Run traceroute</button></div>`;
}
function typeTable(tel) {
  const rows = tel?.by_type || [];
  if (!rows.length) return '';
  return `<div class="pk-card pk-wide"><h3>Packet types in this transfer</h3><div class="pk-type-table"><div class="pk-tt-head"><span>Type</span><span>Dir</span><span>Count</span><span>Data</span><span>Frames</span><span>Overhead</span><span>TCP segs*</span></div>
    ${rows.map(r => `<div><span><b class="pk-type ${typeInfo(r.record_type).cls}">${typeInfo(r.record_type).label}</b></span><span>${r.direction === 'sent' ? '↑ sent' : '↓ recv'}</span><span>${fmtNum(r.records)}</span><span>${size(r.plaintext_bytes)}</span><span>${size(r.frame_bytes)}</span><span>${fmtNum(r.overhead_bytes)} B</span><span>${fmtNum(r.tcp_segments_est)}</span></div>`).join('')}</div></div>`;
}
function packetsView() {
  if (!pk.live && !pk.error) { loadPackets().then(() => { if (currentView === 'packets') render(); }); }
  const transfers = (pk.live?.transfers || []).slice().sort((a, b) => b.started_at - a.started_at);
  const rows = pkRows();
  const tel = pk.detail?.telemetry;
  const mss = tel?.mss || 1460;
  const rowKey = r => pk.transfer ? String(r.sequence) : `${r.transfer_id}:${r.sequence}`;
  if (pk.seq == null || !rows.some(r => rowKey(r) === pk.seq)) {
    const firstData = rows.find(r => r.record_type === 'file_chunk') || rows[0];
    pk.seq = firstData ? rowKey(firstData) : null;
  }
  const selected = rows.find(r => rowKey(r) === pk.seq);
  const totals = pk.transfer ? (tel?.totals || {}) : (pk.live?.totals || {});
  const net = pk.detail?.network;
  const path = net?.remote_ip ? pk.paths[net.remote_ip] : null;
  const types = [...new Set(rows.map(r => r.record_type).concat(Object.keys(TYPE_INFO)))];
  const tableRows = rows.length ? rows.slice(0, 600).map(r => {
    const info = typeInfo(r.record_type);
    const e = encap(r.frame_bytes, r.mss || mss, pk.link);
    return `<button class="pk-row ${rowKey(r) === pk.seq ? 'selected' : ''} ${r.direction}" data-pk-seq="${escapeHTML(rowKey(r))}"><span>${r.sequence}</span><span>${Number(r.time_ms || 0).toFixed(1)}</span><span class="pk-addr">${escapeHTML(r.src || '?')} → ${escapeHTML(r.dst || '?')}</span><span><b class="pk-type ${info.cls}">${info.label}</b></span><span>${fmtNum(r.frame_bytes)}</span><span>${fmtNum(r.tcp_segments_est ?? e.segs)}</span><span class="pk-info">${escapeHTML(recordInfo(r))}</span></button>`;
  }).join('') : `<div class="pk-empty"><strong>No packets captured yet</strong>Send or receive a file — every record is captured live, with no admin rights needed.</div>`;
  const liveNote = !pk.transfer ? `<div class="pk-hint">Live feed across all transfers (newest first). Pick a transfer above to see its full packet list, timeline, kernel TCP counters and network path.</div>` : '';
  return `${heading('NETWORK ANALYZER','Packets','Every record xdrop puts on the network: what type it is, how it is encrypted, how it is split into TCP/IP packets, and which path it takes.', `<div class="pk-actions"><button class="button button-quiet button-small" data-pk-action="pause">${pk.paused ? '▶ Resume' : 'Ⅱ Pause'}</button></div>`)}
    ${pk.error ? `<div class="route-error">${escapeHTML(pk.error)}</div>` : ''}
    <div class="pk-toolbar">
      <select id="pk-transfer" aria-label="Transfer"><option value="">● Live · all transfers</option>${transfers.map(t => `<option value="${escapeHTML(t.id)}" ${pk.transfer === t.id ? 'selected' : ''}>${escapeHTML(t.label || t.id)} · ${fmtNum(t.records)} pkts</option>`).join('')}</select>
      <select id="pk-type" aria-label="Packet type"><option value="">All types</option>${types.map(t => `<option value="${escapeHTML(t)}" ${pk.type === t ? 'selected' : ''}>${typeInfo(t).label}</option>`).join('')}</select>
      <select id="pk-dir" aria-label="Direction"><option value="">Both directions</option><option value="sent" ${pk.dir === 'sent' ? 'selected' : ''}>Sent ↑</option><option value="received" ${pk.dir === 'received' ? 'selected' : ''}>Received ↓</option></select>
      <select id="pk-link" aria-label="Link layer"><option value="wifi" ${pk.link === 'wifi' ? 'selected' : ''}>Link: Wi-Fi 802.11</option><option value="ethernet" ${pk.link === 'ethernet' ? 'selected' : ''}>Link: Ethernet</option></select>
    </div>
    <div class="pk-stats">
      <div class="stat-card"><div class="stat-text"><span>PACKETS (RECORDS)</span><strong>${fmtNum(totals.records)}</strong><small>${pk.transfer && tel ? `${fmtNum(tel.records_kept)} kept for display` : 'captured this session'}</small></div></div>
      <div class="stat-card"><div class="stat-text"><span>FRAME BYTES</span><strong>${size(totals.frame_bytes || 0)}</strong><small>${pk.transfer ? `${pct(totals.overhead_bytes, totals.frame_bytes)} encryption + framing overhead` : 'xdrop frames on TCP'}</small></div></div>
      <div class="stat-card"><div class="stat-text"><span>TCP SEGMENTS</span><strong>${tel?.tcp?.delta_segs_out != null ? fmtNum((tel.tcp.delta_segs_out || 0) + (tel.tcp.delta_segs_in || 0)) : fmtNum(totals.tcp_segments_est)}</strong><small>${tel?.tcp?.delta_segs_out != null ? 'measured by the kernel (in + out)' : 'estimated from MSS'}</small></div></div>
      <div class="stat-card"><div class="stat-text"><span>ON THE WIRE*</span><strong>${size(totals.wire_bytes_est || 0)}</strong><small>incl. TCP, IP and link headers</small></div></div>
    </div>
    ${liveNote}
    <div class="pk-layout">
      <section class="card pk-capture"><div class="pk-head-row"><span>No.</span><span>Time ms</span><span>Source → Destination</span><span>Type</span><span>Bytes</span><span>Segs*</span><span>Info</span></div><div class="pk-table-wrap">${tableRows}</div></section>
      <aside class="card pk-side">${packetDetail(selected, selected?.mss || mss, path)}</aside>
    </div>
    ${pk.transfer && tel ? `<div class="pk-grid">
      <div class="pk-card pk-wide"><h3>Throughput timeline</h3>${timelineChart(tel.timeline)}</div>
      ${typeTable(tel)}
      ${tcpCard(tel)}
      ${pathCard(path, net)}
    </div>` : ''}`;
}
function render() {
  if (!state) { root.innerHTML = '<div class="loading"><div><div class="spinner"></div>Connecting to your xdrop device…</div></div>'; return; }
  const names = {overview:'Overview',devices:'Devices',send:'Send a file',transfers:'Transfers',traffic:'Traffic',packets:'Packets',insights:'Insights',settings:'Settings'};
  pageName.textContent = names[currentView] || 'Overview';
  document.querySelector('#profile-name').textContent = state.device_name;
  document.querySelector('#avatar').textContent = (state.device_name || 'x').slice(0,1).toUpperCase();
  document.querySelector('#peer-count').textContent = (state.peers || []).length;
  document.querySelector('#version').textContent = state.version;
  const connection = document.querySelector('.connection');
  connection.classList.toggle('online', Boolean(state.discovery.zeroconf_active));
  document.querySelector('#connection-label').textContent = state.discovery.zeroconf_active ? 'Network active' : 'Local only';
  document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === currentView));
  const tableScroll = root.querySelector('.pk-table-wrap')?.scrollTop || 0;
  const sideScroll = root.querySelector('.pk-side')?.scrollTop || 0;
  root.classList.toggle('wide', currentView === 'packets');
  root.innerHTML = ({overview,devices:devicesView,send:sendView,transfers:transfersView,traffic:trafficView,packets:packetsView,insights:insightsView,settings:settingsView}[currentView] || overview)();
  if (currentView === 'packets') {
    const wrap = root.querySelector('.pk-table-wrap'); if (wrap) wrap.scrollTop = tableScroll;
    const side = root.querySelector('.pk-side'); if (side) side.scrollTop = sideScroll;
  }
  if (currentView === 'transfers') applyHistoryFilters();
}
async function refresh() {
  try {
    state = await request('/api/state');
    if (currentView === 'packets' && !pk.paused) await loadPackets();
    render();
  }
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
  // Analyzer modal: backdrop click
  if (event.target.id === 'analyzer-modal') { closeAnalyzer(); return; }
  // Analyzer card click: open modal
  const analyzeCard = event.target.closest('[data-analyze-id]');
  if (analyzeCard && !event.target.closest('button') && !event.target.closest('.incoming-actions')) {
    await analyzeTransfer(analyzeCard.dataset.analyzeId);
    return;
  }
  const pkRow = event.target.closest('[data-pk-seq]');
  if (pkRow) {
    const key = pkRow.dataset.pkSeq;
    if (!pk.transfer && key.includes(':')) {   // live feed → drill into that transfer
      const [transferId, seq] = key.split(':');
      pk.transfer = transferId; pk.seq = seq; pk.type = ''; pk.dir = '';
      await loadPackets();
    } else pk.seq = key;
    render();
    return;
  }
  const pkAction = event.target.closest('[data-pk-action]');
  if (pkAction?.dataset.pkAction === 'pause') { pk.paused = !pk.paused; render(); return; }
  const openPackets = event.target.closest('[data-open-packets]');
  if (openPackets) {
    pk.transfer = openPackets.dataset.openPackets; pk.seq = null; pk.type = ''; pk.dir = '';
    closeAnalyzer();
    await loadPackets();
    switchView('packets');
    return;
  }
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
  if (action?.dataset.action === 'scan-network') {
    action.disabled = true; action.textContent = 'Scanning…';
    try { await request('/api/scan', {method:'POST'}); notify('Scanning your network for xdrop devices…'); }
    catch (error) { notify(error.message, true); }
    setTimeout(refresh, 2500);
    return;
  }
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
  if (['pk-transfer','pk-type','pk-dir','pk-link'].includes(event.target.id)) {
    const v = event.target.value;
    if (event.target.id === 'pk-transfer') { pk.transfer = v; pk.seq = null; pk.type = ''; pk.dir = ''; }
    if (event.target.id === 'pk-type') { pk.type = v; pk.seq = null; }
    if (event.target.id === 'pk-dir') { pk.dir = v; pk.seq = null; }
    if (event.target.id === 'pk-link') pk.link = v;
    event.target.blur();
    loadPackets().then(render);
    return;
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
        let target = root.querySelector('#peer-target').value || root.querySelector('#manual-peer').value.trim();
        if (target && !/:\d+$/.test(target)) target = `${target}:${state.default_port || 47474}`;
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
    closeAnalyzer();
  }
});
refresh();
setInterval(() => {
  const focusedControl = root.contains(document.activeElement) && document.activeElement.matches('input,select,textarea');
  if (currentView !== 'send' && !focusedControl) refresh();
}, 1200);
