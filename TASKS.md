# OpenRTC Implementation Tasks & Milestones

The source of truth for architecture and status is [`flow.md`](./flow.md). Each milestone is designed to be completed in 1–3 hours, leaving the codebase green (`npm test` and `npx tsc --noEmit` pass) and committed with `<ID>: <short description>`.

Execution order note: Spikes R4 and S0 run early (after R1) so feasibility of SDP replay slots and werift simulcast negotiation is established before building dependent components. For both spikes, report findings and stop before building on them. Spike tests live under `test/spikes/` and are excluded from `npm test` so they never turn CI/test red.

---

## REWIND-LIVE & EARLY SPIKES

- [ ] **R1: Standalone RollingMediaBuffer**
  - **Goal:** Implement `RollingMediaBuffer.ts` to buffer original RTP packets in memory with arrival timestamps and keyframe index, supporting time-based lookup and keyframe-safe eviction.
  - **Files to touch:** `src/sfu/RollingMediaBuffer.ts`, `test/rollingMediaBuffer.test.ts`
  - **Done when:** Unit tests verify packet storage, `findStart(timestampMs)` returns nearest keyframe <= target time, age-based eviction retains the keyframe immediately preceding the window, and memory stays bounded.
  - **Risks:** Eviction logic might accidentally drop the latest keyframe needed for decoding or leak memory if time deltas are non-monotonic.

- [ ] **R4: Pre-allocated Replay Slots Spike & Negotiation**
  - **Goal:** Spike FIRST: verify whether pre-allocated dedicated replay transceiver / m-sections in the subscriber SDP allow replay stream attachment without renegotiation. Test with `FakeTransport`. Report findings and stop before building on them.
  - **Files to touch:** `test/spikes/replay-slot.spike.ts`, `src/sfu/SubscriberNegotiator.ts`, `src/sfu/Peer.ts`, `src/transport/IMediaTransport.ts`, `src/transport/FakeTransport.ts`
  - **Done when:** Spike test runs without failing `npm test`, validates whether initial subscriber SDP includes pre-allocated replay slots and starting a replay can bind to an existing slot without triggering renegotiation; findings are documented.
  - **Risks:** `werift` or browser SDP answer behavior when pre-allocated inactive/recvonly media sections are used.

- [ ] **S0: Werift Simulcast Spike**
  - **Goal:** Spike FIRST: verify whether werift supports `a=simulcast` SDP negotiation and RTP `rid` / mid header extensions. Report findings and stop before building on them.
  - **Files to touch:** `test/spikes/werift-simulcast.spike.ts`
  - **Done when:** Spike executes against werift `RTCPeerConnection`, reports exact capabilities (supports native rid demux vs needs SSRC/payload type fallback), does not turn `npm test` red, and findings are documented.
  - **Risks:** Werift may lack full RFC 8853 simulcast parsing, requiring SSRC-based or mid-based multiplexing fallback.

- [ ] **R2: Hook Buffer into Producer**
  - **Goal:** Connect `RollingMediaBuffer` to `Producer.ts` on RTP receipt, controlled by config flag (`enableRewind`, buffer duration), with zero overhead when disabled.
  - **Files to touch:** `src/config.ts`, `src/sfu/Producer.ts`, `src/sfu/Room.ts`, `test/producer.test.ts`
  - **Done when:** Producer pushes packets to its buffer synchronously with arrival timestamp without blocking forwarding; buffer stays bounded; rewind can be disabled via config without allocating buffers.
  - **Risks:** Adding overhead to the hot synchronous per-packet forwarding path if buffer operations allocate or copy payloads.

- [ ] **R3: Replay Signaling Protocol & Handlers**
  - **Goal:** Define Zod schemas and signaling request/notification handlers for initiating, controlling, and stopping replay sessions, enforcing Flowspace zone boundaries.
  - **Files to touch:** `src/signaling/protocol.ts`, `src/signaling/SignalingServer.ts`, `src/sfu/Room.ts`, `src/sfu/Peer.ts`, `test/signaling.test.ts`
  - **Done when:** Valid `replay.start` and `replay.stop` requests receive `ok` responses; invalid parameters fail with appropriate error codes; `replay.start` MUST fail with an error if the track owner is in a different Flowspace zone than the requester; tested with dedicated unit test; `replay.started` and `replay.ended` notifications are dispatched to the subscriber.
  - **Risks:** Cross-zone leakage if zone validation check is bypassed or track owner moves zones during replay.

- [ ] **R5: ReplayConsumer with Dedicated Rewriter & Paced Pump**
  - **Goal:** Implement `ReplayConsumer.ts` reading from `RollingMediaBuffer` using its own `RtpRewriter` (dedicated SSRC, continuous sequence numbers & timestamps) and a paced timer pump matching original packet timing.
  - **Files to touch:** `src/sfu/ReplayConsumer.ts`, `src/sfu/Room.ts`, `test/replayConsumer.test.ts`
  - **Done when:** Replay packets are emitted with monotonic sequence numbers and paced intervals verified with ViTest fake timers; packet rewriter maintains continuous timeline regardless of live stream timeline.
  - **Risks:** Timer drift in Node.js event loop causing replay buffer underrun or burstiness.

- [ ] **R6: Audio/Video Pairing & Catch-Up to Live**
  - **Goal:** Coordinate audio and video replay streams by packet arrival timestamp with jitter tolerance to preserve lip-sync; detect catch-up to live write head; cleanly teardown ReplayConsumers on completion or stop.
  - **Files to touch:** `src/sfu/ReplayConsumer.ts`, `src/sfu/Room.ts`, `test/replaySync.test.ts`
  - **Done when:** Tests prove paired A/V replay packets interleave within tolerance; hitting the buffer head transitions cleanly with `replay.ended` (reason: `caught-up`); manual stop cleans up all timers and slots.
  - **Risks:** Jitter between audio and video arrival times; mitigated by using arrival-time pairing with a configurable jitter tolerance window.

- [ ] **R7: Client SDK & Demo UI for Rewind**
  - **Goal:** Expose replay methods in `SfuClient.ts` (`replayStart`, `replayStop`, event listeners) and add UI controls in `client/demo/` (buttons, badge/overlay, "Back to live").
  - **Files to touch:** `client/SfuClient.ts`, `client/demo/index.html`, `client/demo/main.ts`
  - **Done when:** Client can request rewind via SDK, attach replay stream to video element with visual indicator, and return to live cleanly; demo UI renders controls and handles state transitions.
  - **Risks:** Browser media element glitching or pausing when swapping or attaching replay tracks.

- [ ] **R8: Rewind Memory Soak Test**
  - **Goal:** Create a long-running soak simulation test asserting that memory remains flat and bounded while streaming and continuously evicting 10 minutes of simulated media.
  - **Files to touch:** `test/rewindSoak.test.ts`
  - **Done when:** Test pushes 10 minutes worth of simulated 30fps video packets; asserts that (a) buffer packet and byte counts never exceed the configured cap and (b) heap growth after forced garbage collection stays under a fixed threshold (vitest with `--expose-gc`).
  - **Risks:** Garbage collection timing non-determinism; mitigated by explicit `global.gc()` calls before measuring baseline and post-run heap.

---

## UNIVERSAL CAPTIONS

- [ ] **C1: AudioTap Interface & Producer Hook**
  - **Goal:** Define `AudioTap` interface and hook it into `Producer.ts` for audio tracks when captions are active, disabled by default with zero performance impact when off.
  - **Files to touch:** `src/sfu/AudioTap.ts`, `src/sfu/Producer.ts`, `src/sfu/Room.ts`, `test/audioTap.test.ts`
  - **Done when:** Unit tests verify `AudioTap` receives audio payload buffers and metadata only when enabled; zero allocations/callbacks when disabled.
  - **Risks:** Tapping audio introduces copy overhead or backpressure on real-time forwarding.

- [ ] **C2: Python ASR Server Skeleton**
  - **Goal:** Build the standalone Python ASR service skeleton accepting binary audio frames over WebSocket and returning JSON caption messages; document the binary wire format.
  - **Files to touch:** `asr/server.py`, `asr/requirements.txt`, `asr/README.md`
  - **Done when:** Python server starts, accepts WS connection, ingests binary frame header + audio payload, and emits dummy JSON caption notifications conforming to protocol.
  - **Risks:** Python dependencies setup or platform compatibility across environments.

- [ ] **C3: Real ASR Pipeline (Opus -> PCM -> VAD -> faster-whisper)**
  - **Goal:** Implement real transcription pipeline in `asr/server.py` using pyav/opus decoding to 16kHz mono PCM, Silero VAD for utterance splitting, and faster-whisper for partial and final text generation.
  - **Files to touch:** `asr/server.py`, `asr/transcriber.py`, `asr/requirements.txt`, `asr/test_pipeline.py`
  - **Done when:** Script passes synthetic/recorded Opus audio through pipeline and outputs correct partial (interim) and final transcripts with timestamps.
  - **Risks:** High inference latency on CPU; model downloading overhead on first start.

- [ ] **C4: Node AsrClient with Backpressure & Zone-Aware Broadcast**
  - **Goal:** Implement `AsrClient.ts` in Node.js connecting to Python ASR service via WebSocket, handling reconnects, dropping audio on backpressure, and dispatching `caption.text` notifications filtered by Flowspace zone.
  - **Files to touch:** `src/sfu/AsrClient.ts`, `src/sfu/Room.ts`, `src/signaling/protocol.ts`, `src/signaling/SignalingServer.ts`, `test/asrClient.test.ts`
  - **Done when:** Signaling commands `captions.enable` and `captions.disable` toggle tap; ASR client drops stale frames when queue exceeds threshold; captions are broadcast only to peers in speaker's zone.
  - **Risks:** ASR service disconnection or crash destabilizing the Node.js SFU process.

- [ ] **C5: Client SDK & Subtitle Overlay Demo UI**
  - **Goal:** Add captions API to `SfuClient.ts` and render real-time subtitles over participant tiles in the demo UI with auto-fade after inactivity.
  - **Files to touch:** `client/SfuClient.ts`, `client/demo/index.html`, `client/demo/main.ts`
  - **Done when:** SDK receives `caption.text` events; demo UI displays subtitle overlay over corresponding speaker tile, updates partial text in-place, and fades out 3 seconds after final text.
  - **Risks:** Subtitle flicker or layout shifts during rapid partial caption updates.

- [ ] **C6: Optional Translation Service Integration**
  - **Goal:** Extend Python ASR service and signaling to support target language selection, translating final transcripts via Argos Translate or NLLB.
  - **Files to touch:** `asr/translator.py`, `asr/server.py`, `src/signaling/protocol.ts`, `client/demo/main.ts`
  - **Done when:** Specifying target language in `captions.enable({ language: 'es' })` translates transcripts before dispatching `caption.text`; unit tests verify translation pass-through.
  - **Risks:** Translation model memory footprint and additional inference latency.

---

## SIMULCAST + CONGESTION CONTROL

- [ ] **S1: Client sendEncodings (q/h/f) & SDP Handling**
  - **Goal:** Update client SDK and server SDP negotiation to configure 3 video encodings (quarter, half, full resolution) on the publisher PeerConnection.
  - **Files to touch:** `client/SfuClient.ts`, `src/transport/WeriftTransport.ts`, `src/signaling/protocol.ts`
  - **Done when:** Client initializes video transceiver with `sendEncodings: [{rid:'q'}, {rid:'h'}, {rid:'f'}]`; server successfully answers and establishes DTLS/SRTP with simulcast offer.
  - **Risks:** Browser-specific SDP differences between Chrome and Safari when handling `a=simulcast`.

- [ ] **S2: Producer rid Demux & Layer State**
  - **Goal:** Enhance `Producer.ts` to demultiplex incoming RTP packets by `rid` (or mapped SSRC), maintaining per-layer packet/byte counts, keyframe controllers, and keyframe state.
  - **Files to touch:** `src/sfu/Producer.ts`, `src/sfu/codecs/vp8.ts`, `test/producerSimulcast.test.ts`
  - **Done when:** Packets tagged with `q`, `h`, and `f` are demuxed to independent layer streams with separate keyframe tracking; unit tests verify routing.
  - **Risks:** Werift RTP parser may not surface header extension `rid` without explicit extension configuration.

- [ ] **S3: Consumer Layer Switching on Keyframe**
  - **Goal:** Implement layer switching in `Consumer.ts` where target layer changes trigger a keyframe request on the target layer, forwarding old layer until target keyframe arrives, then rebasing `RtpRewriter`.
  - **Files to touch:** `src/sfu/Consumer.ts`, `src/sfu/RtpRewriter.ts`, `test/consumerLayerSwitch.test.ts`
  - **Done when:** Layer switches cleanly on keyframe boundary; outgoing sequence numbers and timestamps are perfectly continuous with no decoder artifacting.
  - **Risks:** Delayed keyframe on target layer causes stall or abrupt gap if fallback timeout is triggered.

- [ ] **S4: Loss-Based Layer Selection with Hysteresis**
  - **Goal:** Upgrade `LayerSelector.ts` to evaluate RTCP Receiver Report fraction loss, stepping down layers when loss > 5% and stepping up only after 10 seconds of stable low loss.
  - **Files to touch:** `src/sfu/LayerSelector.ts`, `src/sfu/Consumer.ts`, `test/layerSelector.test.ts`
  - **Done when:** Unit tests simulate high loss triggering down-switch (f -> h -> q) and sustained low loss triggering step-up with 10s cooldown preventing flapping.
  - **Risks:** Flapping between layers on fluctuating network loss.

- [ ] **S5: Telemetry UI for Simulcast Layers**
  - **Goal:** Emit `subscription.changed` with layer metadata and render active layer badges (Q / H / F) on video tiles in the client demo.
  - **Files to touch:** `src/signaling/protocol.ts`, `client/SfuClient.ts`, `client/demo/index.html`, `client/demo/main.ts`
  - **Done when:** Layer switches update client state and reflect dynamically on tile UI badges; `toStats()` exports per-layer metrics.
  - **Risks:** High signaling message frequency if layer adjustments occur too rapidly.

- [ ] **S6: (Optional) TWCC Parsing & Estimator**
  - **Goal:** Time-boxed investigation and implementation of RTCP transport-wide congestion control (TWCC) feedback parsing and delay-based bandwidth estimation, or document as future work.
  - **Files to touch:** `src/sfu/TwccEstimator.ts`, `src/sfu/Consumer.ts`, `docs/congestion-control.md`
  - **Done when:** Either TWCC feedback parses packet arrival deltas into bandwidth estimates, or comprehensive documentation details why loss-based selection was chosen and specifies TWCC integration path.
  - **Risks:** Significant complexity of delay-based Kalman filter / GCC estimator exceeding time box.

---

## BENCHMARK

- [ ] **B1: Load Generator (Playwright Bots & Synthetic RTP)**
  - **Goal:** Create automated load testing script capable of spawning headless browser peers (Playwright fake media) or headless synthetic RTP senders into rooms with 4, 8, and 12 participants.
  - **Files to touch:** `test/benchmark/load-generator.ts`, `test/benchmark/package.json`
  - **Done when:** Script can autonomously launch N peers, join room, publish audio+video, subscribe to all, and run for configurable duration without manual input.
  - **Risks:** Headless Chrome CPU exhaustion on the local benchmark runner machine when running 12+ instances.

- [ ] **B2: Metrics Collector (CPU, RSS, Latency, Loss -> CSV)**
  - **Goal:** Build benchmark collector polling Docker / system stats (CPU %, RSS MB) and SFU `/api/stats` / `/metrics`, recording time series into structured CSV files.
  - **Files to touch:** `test/benchmark/collector.ts`, `test/benchmark/runner.ts`
  - **Done when:** Benchmark run produces `results.csv` containing timestamps, peer counts, CPU, memory, packet loss, and egress bandwidth.
  - **Risks:** Polling frequency causing measurement perturbation.

- [ ] **B3: Docker Limits & Network Impairment (tc netem)**
  - **Goal:** Package SFU into container with fixed CPU/RAM limits and create Linux traffic control (`tc netem`) scripts to apply 0%, 2%, 5%, and 10% packet loss plus delay and jitter.
  - **Files to touch:** `test/benchmark/docker-compose.bench.yml`, `test/benchmark/scripts/netem.sh`
  - **Done when:** Scripts apply and tear down netem impairment rules reproducibly on target network interfaces under Docker.
  - **Risks:** Windows host network limitations (requires WSL2 or Linux Docker container environment for `tc`).

- [ ] **B4: mediasoup Target Adapter**
  - **Goal:** Create minimal benchmark harness container running mediasoup SFU with equivalent room/codec configuration to execute identical load scenarios.
  - **Files to touch:** `test/benchmark/adapters/mediasoup/`
  - **Done when:** Load generator can target mediasoup instance and collector captures identical metrics schema.
  - **Risks:** Configuration mismatch between mediasoup worker settings and OpenRTC.

- [ ] **B5: LiveKit Target Adapter**
  - **Goal:** Create minimal benchmark harness container running LiveKit server with equivalent room/codec configuration to execute identical load scenarios.
  - **Files to touch:** `test/benchmark/adapters/livekit/`
  - **Done when:** Load generator can target LiveKit instance and collector captures identical metrics schema.
  - **Risks:** Incompatible client SDK requiring dual load-generator implementations.

- [ ] **B6: Janus Target Adapter**
  - **Goal:** Create minimal benchmark harness container running Janus VideoRoom plugin to execute identical load scenarios.
  - **Files to touch:** `test/benchmark/adapters/janus/`
  - **Done when:** Load generator can target Janus instance and collector captures identical metrics schema.
  - **Risks:** Janus complex SDP negotiation and HTTP/WS signaling differing from standard SFU protocol.

- [ ] **B7: Results Visualization & Summary Report**
  - **Goal:** Write Python/matplotlib visualization script generating graphs (CPU vs peers, RSS vs duration, loss behavior, Flowspace switch latency vs full rejoin) and a markdown summary report.
  - **Files to touch:** `test/benchmark/plot_results.py`, `docs/benchmark-report.md`
  - **Done when:** Running script generates publication-quality PNG charts comparing OpenRTC, mediasoup, LiveKit, and Janus, plus feature cost table (Rewind RAM, Captions CPU, Flowspace switch time).
  - **Risks:** Missing Python visualization packages in user environment.

---

## HOUSEKEEPING

- [ ] **H1: Project Renaming to OpenRTC**
  - **Goal:** Unify product branding to "OpenRTC" across `package.json`, source files, UI templates, test files, and documentation, removing legacy names "mini-sfu" and "RelaySync".
  - **Files to touch:** `package.json`, `README.md`, `client/demo/index.html`, `client/demo/main.ts`, `src/config.ts`, `flow.md`
  - **Done when:** Search for `mini-sfu` and `RelaySync` across the codebase returns no active references; test suite and build remain green.
  - **Risks:** Broken import or script path if package name changes affect local resolution.

- [ ] **H2: Grafana Dashboard JSON for /metrics**
  - **Goal:** Create a production-ready Grafana dashboard JSON file visualizing Prometheus metrics exported by `/metrics` (active rooms, peers, bitrates, packet loss, PLIs, CPU, memory).
  - **Files to touch:** `deploy/grafana/dashboard.json`, `deploy/prometheus.yml`, `README.md`
  - **Done when:** Dashboard JSON imports into Grafana cleanly and renders panels for SFU throughput, active peers, keyframe rates, and consumer loss.
  - **Risks:** Metric name discrepancies between `src/util/metrics.ts` and dashboard panel queries.

- [ ] **H3: Living Status Documentation in flow.md**
  - **Goal:** Maintain `flow.md` as the living source of truth by updating status badges (🔲 -> 🟡 -> ✅) and progress tables at the completion of each milestone.
  - **Files to touch:** `flow.md`
  - **Done when:** Status tags in section 0 and feature sections accurately reflect milestone completion state in git history.
  - **Risks:** Merge conflicts or desynchronization between code state and documentation.
