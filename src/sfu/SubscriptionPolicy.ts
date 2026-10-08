import type { Peer } from './Peer.js';
import type { Producer } from './Producer.js';

export interface SubscriptionPolicy {
  shouldAutoSubscribe(subscriber: Peer, producer: Producer): boolean;
}

export class SubscribeAllPolicy implements SubscriptionPolicy {
  shouldAutoSubscribe(subscriber: Peer, producer: Producer): boolean {
    return subscriber.autoSubscribe && subscriber.id !== producer.peerId;
  }
}
