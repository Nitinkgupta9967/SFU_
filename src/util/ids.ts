import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const makeId = customAlphabet(alphabet, 10);
const makeTrackId = customAlphabet(alphabet, 8);

export function newPeerId(): string {
  return `p_${makeId()}`;
}

export function newTransportId(): string {
  return `t_${makeId()}`;
}

export function newTrackSid(): string {
  return `TR_${makeTrackId()}`;
}

export function newRoomId(): string {
  return `room_${makeId()}`;
}

export function newReconnectToken(): string {
  return `rt_${makeId()}`;
}
