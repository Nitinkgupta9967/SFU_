import { describe, expect, it } from 'vitest';
import { signRoomToken, verifyRoomToken } from '../src/api/auth.js';

describe('room tokens', () => {
  it('signs and verifies room-scoped JWTs', () => {
    const token = signRoomToken({ roomId: 'demo', displayName: 'Alice', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');

    expect(verifyRoomToken(token, 'secret')).toMatchObject({
      roomId: 'demo',
      displayName: 'Alice'
    });
  });

  it('rejects bad signatures', () => {
    const token = signRoomToken({ roomId: 'demo', exp: Math.floor(Date.now() / 1000) + 60 }, 'secret');

    expect(() => verifyRoomToken(token, 'other-secret')).toThrow('bad token signature');
  });
});
