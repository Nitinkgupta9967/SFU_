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

let client: SfuClient | undefined;
let camera: LocalTrack | undefined;
let mic: LocalTrack | undefined;

joinButton.onclick = async () => {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  client = new SfuClient({
    url: `${wsProtocol}//${location.host}/ws`,
    roomId: roomInput.value,
    displayName: nameInput.value
  });
  client.on('trackSubscribed', (track: MediaStreamTrack, info: { peerId: string }) => addRemoteTrack(track, info.peerId));
  client.on('peerLeft', (peerId: string) => removePeerTiles(peerId));
  client.on('activeSpeakers', (peerIds: string[]) => highlightSpeakers(peerIds));
  client.on('connectionState', (state: string) => updateStatus(state));
  client.on('error', (error: Error) => console.error(error));
  await client.connect();
  joinButton.disabled = true;
  leaveButton.disabled = false;
  cameraButton.disabled = false;
  micButton.disabled = false;
};

leaveButton.onclick = async () => {
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
};

cameraButton.onclick = async () => {
  if (!client) return;
  if (camera) {
    const nextEnabled = !camera.track.enabled;
    await client.setMuted(camera, !nextEnabled);
    cameraButton.classList.toggle('active', nextEnabled);
    cameraButton.textContent = nextEnabled ? '📷 Camera On' : '📷 Camera Off';
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const [track] = stream.getVideoTracks();
  camera = await client.publish(track, 'camera');
  cameraButton.classList.add('active');
  cameraButton.textContent = '📷 Camera On';
  addLocalTrack(track, 'camera');
};

micButton.onclick = async () => {
  if (!client) return;
  if (mic) {
    const nextEnabled = !mic.track.enabled;
    await client.setMuted(mic, !nextEnabled);
    micButton.classList.toggle('active', nextEnabled);
    micButton.textContent = nextEnabled ? '🎙️ Mic On' : '🎙️ Mic Off';
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const [track] = stream.getAudioTracks();
  mic = await client.publish(track, 'microphone');
  micButton.classList.add('active');
  micButton.textContent = '🎙️ Mic On';
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
