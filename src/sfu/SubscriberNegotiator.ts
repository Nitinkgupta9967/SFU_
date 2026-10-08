import type { NotificationEnvelope } from '../signaling/protocol.js';
import { notification } from '../signaling/protocol.js';
import type { IMediaTransport } from '../transport/IMediaTransport.js';
import type { Clock } from '../util/time.js';
import { systemClock } from '../util/time.js';
import type { Peer } from './Peer.js';

type NegotiatorState = 'idle' | 'debouncing' | 'awaiting-answer';

export interface SubscriberNegotiatorOptions {
  peer: Peer;
  transport: IMediaTransport;
  debounceMs: number;
  answerTimeoutMs?: number;
  clock?: Clock;
}

export class SubscriberNegotiator {
  private state: NegotiatorState = 'idle';
  private dirty = false;
  private offerId = 0;
  private debounceTimer?: NodeJS.Timeout;
  private answerTimer?: NodeJS.Timeout;

  constructor(private readonly options: SubscriberNegotiatorOptions) {}

  markDirty(): void {
    this.dirty = true;
    if (this.state === 'idle') {
      this.startDebounce();
    }
  }

  async restartIce(): Promise<{ offerId: number; sdp: { type: 'offer' | 'answer'; sdp: string } }> {
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
    this.dirty = false;
    const sdp = await this.options.transport.createOffer({ iceRestart: true });
    this.offerId += 1;
    this.state = 'awaiting-answer';
    this.answerTimer = this.clock.setTimeout(() => {
      this.state = 'idle';
      this.markDirty();
    }, this.options.answerTimeoutMs ?? 10_000);
    return { offerId: this.offerId, sdp };
  }

  async onAnswer(offerId: number, sdp: { type: 'answer'; sdp: string }): Promise<boolean> {
    if (this.state !== 'awaiting-answer' || offerId !== this.offerId) {
      return false;
    }
    this.clearAnswerTimer();
    await this.options.transport.setRemoteDescription(sdp);
    this.state = 'idle';
    if (this.dirty) {
      this.startDebounce();
    }
    return true;
  }

  close(): void {
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
    this.clearAnswerTimer();
  }

  private startDebounce(): void {
    this.state = 'debouncing';
    if (this.debounceTimer) {
      this.clock.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = this.clock.setTimeout(() => {
      void this.sendOffer();
    }, this.options.debounceMs);
  }

  private async sendOffer(): Promise<void> {
    this.debounceTimer = undefined;
    this.dirty = false;
    const sdp = await this.options.transport.createOffer();
    this.offerId += 1;
    this.state = 'awaiting-answer';
    const message = this.buildOfferNotification(this.offerId, sdp);
    this.options.peer.send(message);
    this.answerTimer = this.clock.setTimeout(() => {
      this.state = 'idle';
      this.markDirty();
    }, this.options.answerTimeoutMs ?? 10_000);
  }

  private buildOfferNotification(offerId: number, sdp: { type: 'offer' | 'answer'; sdp: string }): NotificationEnvelope {
    const mids = [...this.options.peer.consumers.values()].map((consumer) => ({
      mid: consumer.mid,
      trackSid: consumer.producer.trackSid,
      peerId: consumer.producer.peerId
    }));
    return notification('subscriber.offer', { offerId, sdp, mids });
  }

  private clearAnswerTimer(): void {
    if (!this.answerTimer) return;
    this.clock.clearTimeout(this.answerTimer);
    this.answerTimer = undefined;
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
}
