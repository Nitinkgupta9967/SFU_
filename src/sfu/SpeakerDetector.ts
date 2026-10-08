export interface SpeakerInfo {
  peerId: string;
  level: number;
}

interface Sample {
  at: number;
  level: number;
  voice: boolean;
}

export class SpeakerDetector {
  private readonly samplesByPeer = new Map<string, Sample[]>();
  private lastEmitAt = 0;
  private lastSignature = '';

  constructor(
    private readonly options: {
      threshold: number;
      windowMs?: number;
      emitIntervalMs?: number;
      topK?: number;
      now?: () => number;
    }
  ) {}

  update(peerId: string, level: number, voice: boolean): SpeakerInfo[] | undefined {
    const now = this.now();
    const windowMs = this.options.windowMs ?? 500;
    const samples = this.samplesByPeer.get(peerId) ?? [];
    samples.push({ at: now, level, voice });
    this.samplesByPeer.set(
      peerId,
      samples.filter((sample) => now - sample.at <= windowMs)
    );

    if (now - this.lastEmitAt < (this.options.emitIntervalMs ?? 300)) {
      return undefined;
    }

    const speakers = this.currentSpeakers();
    const signature = speakers.map((speaker) => `${speaker.peerId}:${Math.round(speaker.level)}`).join('|');
    if (signature === this.lastSignature) {
      return undefined;
    }
    this.lastSignature = signature;
    this.lastEmitAt = now;
    return speakers;
  }

  currentSpeakers(): SpeakerInfo[] {
    const now = this.now();
    const windowMs = this.options.windowMs ?? 500;
    const speakers: SpeakerInfo[] = [];

    for (const [peerId, samples] of this.samplesByPeer.entries()) {
      const active = samples.filter((sample) => now - sample.at <= windowMs && sample.voice);
      if (active.length === 0) continue;
      const level = active.reduce((sum, sample) => sum + sample.level, 0) / active.length;
      if (level <= this.options.threshold) {
        speakers.push({ peerId, level });
      }
    }

    return speakers.sort((a, b) => a.level - b.level).slice(0, this.options.topK ?? 3);
  }

  removePeer(peerId: string): void {
    this.samplesByPeer.delete(peerId);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
