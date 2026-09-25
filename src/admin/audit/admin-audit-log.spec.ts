import { HttpException } from '@nestjs/common';
import {
  decodeAuditCursor,
  encodeAuditCursor,
} from './admin-audit-log.service';

const ID = '11111111-1111-4111-8111-111111111111';
const b64 = (text: string) => Buffer.from(text).toString('base64url');

describe('kursor dziennika audytu', () => {
  it('tam i z powrotem bez strat', () => {
    const cursor = { at: new Date('2026-09-25T10:00:00.123Z'), id: ID };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'śmieci',
    b64(`nie-data|${ID}`),
    b64('2026-09-25T10:00:00.000Z|nie-uuid'),
    b64(`2026-09-25T10:00:00.000Z|${ID}|x`),
  ])('zły kursor → 400 (%s)', (raw) => {
    let caught: unknown = null;
    try {
      decodeAuditCursor(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
  });
});
