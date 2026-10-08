import { SfuClient, type LocalTrack } from '../SfuClient.js';

const joinButton = document.querySelector<HTMLButtonElement>('#join')!;
const leaveButton = document.querySelector<HTMLButtonElement>('#leave')!;
const cameraButton = document.querySelector<HTMLButtonElement>('#camera')!;
const micButton = document.querySelector<HTMLButtonElement>('#mic')!;
const roomInput = document.querySelector<HTMLInputElement>('#room')!;
const nameInput = document.querySelector<HTMLInputElement>('#name')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const statusText = document.querySelector<HTMLSpanElement>('#status-text')!;
const grid = document.querySelector<HTMLDivElement>('#grid')!;
const emptyState = document.querySelector<HTMLDivElement>('#empty-state')!;
const logsContainer = document.querySelector<HTMLDivElement>('#logs-container')!;

// Navigation Tabs
const tabGrid = document.querySelector<HTMLButtonElement>('#tab-grid')!;
const tabPipeline = document.querySelector<HTMLButtonElement>('#tab-pipeline')!;
const tabLogs = document.querySelector<HTMLButtonElement>('#tab-logs')!;

const contentGrid = document.querySelector<HTMLDivElement>('#content-grid')!;
const contentPipeline = document.querySelector<HTMLDivElement>('#content-pipeline')!;
const contentLogs = document.querySelector<HTMLDivElement>('#content-logs')!;

// Telemetry Metric Elements
const metricIngress = document.querySelector<HTMLSpanElement>('#metric-ingress')!;
const metricEgress = document.querySelector<HTMLSpanElement>('#metric-egress')!;
const metricPeers = document.querySelector<HTMLSpanElement>('#metric-peers')!;
const metricProducers = document.querySelector<HTMLSpanElement>('#metric-producers')!;
const metricConsumers = document.querySelector<HTMLSpanElement>('#metric-consumers')!;

let client: SfuClient | undefined;
let camera: LocalTrack | undefined;
let mic: LocalTrack | undefined;
let telemetryTimer: number | undefined;

// Tab Switching
tabGrid.onclick = () => switchTab('grid');
tabPipeline.onclick = () => switchTab('pipeline');
tabLogs.onclick = () => switchTab('logs');

function switchTab(tab: 'grid' | 'pipeline' | 'logs'): void {
  tabGrid.classList.toggle('active', tab === 'grid');
  tabPipeline.classList.toggle('active', tab === 'pipeline');
  tabLogs.classList.toggle('active', tab === 'logs');

  contentGrid.classList.toggle('active', tab === 'grid');
  contentPipeline.classList.toggle('active', tab === 'pipeline');
  contentLogs.classList.toggle('active', tab === 'logs');
}

joinButton.onclick = async () => {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  client = new SfuClient({
    url: `${wsProtocol}//${location.host}/ws`,
    roomId: roomInput.value,
    displayName: nameInput.value
  });
  client.on('trackSubscribed', (track: MediaStreamTrack, info: { peerId: string }) => {
    addRemoteTrack(track, info.peerId);
    logProtocol('trackSubscribed', { peerId: info.peerId, trackId: track.id, kind: track.kind });
  });
  client.on('peerLeft', (peerId: string) => {
    removePeerTiles(peerId);
    logProtocol('peerLeft', { peerId });
  });
  client.on('activeSpeakers', (peerIds: string[]) => {
    highlightSpeakers(peerIds);
    if (peerIds.length > 0) logProtocol('speakers.changed', { activeSpeakers: peerIds });
  });
  client.on('connectionState', (state: string) => {
    updateStatus(state);
    logProtocol('connectionState', { state });
  });
  client.on('error', (error: Error) => {
    console.error(error);
    logProtocol('error', { message: error.message });
  });

  await client.connect();
  logProtocol('connected', { roomId: roomInput.value, displayName: nameInput.value });
  joinButton.disabled = true;
  leaveButton.disabled = false;
  cameraButton.disabled = false;
  micButton.disabled = false;

  startTelemetryPolling(roomInput.value);
};

leaveButton.onclick = async () => {
  stopTelemetryPolling();
  await client?.disconnect();
  client = undefined;
  camera = undefined;
  mic = undefined;
  clearGrid();
  joinButton.disabled = false;
  leaveButton.disabled = true;
  cameraButton.disabled = true;
  micButton.disabled = true;
  cameraButton.classList.remove('active');
  micButton.classList.remove('active');
  cameraButton.textContent = '📷 Camera';
  micButton.textContent = '🎙️ Mic';
  updateStatus('disconnected');
  logProtocol('disconnected', {});
};

cameraButton.onclick = async () => {
  if (!client) return;
  if (camera) {
    const nextEnabled = !camera.track.enabled;
    await client.setMuted(camera, !nextEnabled);
    cameraButton.classList.toggle('active', nextEnabled);
    cameraButton.textContent = nextEnabled ? '📷 Camera On' : '📷 Camera Off';
    logProtocol('track.mute', { kind: 'camera', muted: !nextEnabled });
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const [track] = stream.getVideoTracks();
  camera = await client.publish(track, 'camera');
  cameraButton.classList.add('active');
  cameraButton.textContent = '📷 Camera On';
  addLocalTrack(track, 'camera');
  logProtocol('track.publish', { kind: 'camera', trackSid: camera.trackSid });
};

micButton.onclick = async () => {
  if (!client) return;
  if (mic) {
    const nextEnabled = !mic.track.enabled;
    await client.setMuted(mic, !nextEnabled);
    micButton.classList.toggle('active', nextEnabled);
    micButton.textContent = nextEnabled ? '🎙️ Mic On' : '🎙️ Mic Off';
    logProtocol('track.mute', { kind: 'mic', muted: !nextEnabled });
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const [track] = stream.getAudioTracks();
  mic = await client.publish(track, 'microphone');
  micButton.classList.add('active');
  micButton.textContent = '🎙️ Mic On';
  logProtocol('track.publish', { kind: 'microphone', trackSid: mic.trackSid });
};

function updateStatus(state: string): void {
  statusText.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  statusEl.className = `status-pill ${state.toLowerCase()}`;
}

function addLocalTrack(track: MediaStreamTrack, label: string): void {
  const stream = new MediaStream([track]);
  addVideo(stream, `local-${label}`, `You (${label})`, true);
}

function addRemoteTrack(track: MediaStreamTrack, peerId: string): void {
  const stream = new MediaStream([track]);
  addVideo(stream, `${peerId}-${track.id}`, peerId, false);
}

function addVideo(stream: MediaStream, id: string, label: string, muted: boolean): void {
  hideEmptyState();
  let tile = document.getElementById(id);
  if (tile) return;
  tile = document.createElement('div');
  tile.id = id;
  tile.className = 'tile';
  tile.dataset.peerId = label;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;
  const caption = document.createElement('div');
  caption.className = 'tile-label';
  const dot = document.createElement('span');
  dot.className = 'tile-speaking-badge';
  caption.append(dot, document.createTextNode(label));
  tile.append(video, caption);
  grid.append(tile);
}

function removePeerTiles(peerId: string): void {
  for (const tile of Array.from(grid.querySelectorAll(`[data-peer-id="${peerId}"]`))) {
    tile.remove();
  }
  checkEmptyState();
}

function clearGrid(): void {
  grid.replaceChildren();
  grid.append(emptyState);
  emptyState.style.display = 'flex';
}

function hideEmptyState(): void {
  if (emptyState) emptyState.style.display = 'none';
}

function checkEmptyState(): void {
  const tiles = grid.querySelectorAll('.tile');
  if (tiles.length === 0 && emptyState) {
    emptyState.style.display = 'flex';
  }
}

function highlightSpeakers(peerIds: string[]): void {
  for (const tile of Array.from(grid.querySelectorAll('.tile'))) {
    const id = (tile as HTMLElement).dataset.peerId ?? '';
    tile.classList.toggle('speaking', peerIds.includes(id));
  }
}

function startTelemetryPolling(roomId: string): void {
  stopTelemetryPolling();
  telemetryTimer = globalThis.setInterval(async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}`);
      if (!res.ok) return;
      const data = await res.json();
      metricIngress.textContent = `${data.ingressKbps ?? 0} Kbps`;
      metricEgress.textContent = `${data.egressKbps ?? 0} Kbps`;
      metricPeers.textContent = String(data.peerCount ?? 0);
      metricProducers.textContent = String(data.producers ?? 0);
      metricConsumers.textContent = String(data.consumers ?? 0);
    } catch {
      // Ignore background telemetry errors
    }
  }, 2000) as unknown as number;
}

function stopTelemetryPolling(): void {
  if (telemetryTimer) {
    globalThis.clearInterval(telemetryTimer);
    telemetryTimer = undefined;
  }
  metricIngress.textContent = '0.0 Kbps';
  metricEgress.textContent = '0.0 Kbps';
  metricPeers.textContent = '0';
  metricProducers.textContent = '0';
  metricConsumers.textContent = '0';
}

function logProtocol(event: string, data: unknown): void {
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = `[${new Date().toLocaleTimeString()}]`;

  const evt = document.createElement('span');
  evt.className = 'log-event';
  evt.textContent = event;

  const payload = document.createElement('span');
  payload.className = 'log-data';
  payload.textContent = JSON.stringify(data);

  entry.append(time, evt, payload);
  logsContainer.prepend(entry);
}
