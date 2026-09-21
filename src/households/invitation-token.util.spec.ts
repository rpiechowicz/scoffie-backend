import { createHash } from 'crypto';
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationLookup,
  parseInboxHandle,
  toInboxHandle,
} from './invitation-token.util';

const ID = '7b1f0c52-3d0e-4c0a-9a53-2f6f3c1d9e10';
const USER = '11111111-1111-4111-8111-111111111111';

describe('invitation-token.util', () => {
  it('token ma 128 bitów (32 hex), a hasz to sha256 hex — zgodny z backfillem SQL', () => {
    const { token, tokenHash } = generateInvitationToken();

    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    // Migracja liczy `encode(sha256(convert_to(token, 'UTF8')), 'hex')` —
    // aplikacja musi liczyć dokładnie to samo, inaczej stare linki gasną.
    expect(tokenHash).toBe(
      createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex'),
    );
    expect(hashInvitationToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('kolejne tokeny się nie powtarzają', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateInvitationToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it('uchwyt skrzynki wraca do id, a wszystko inne jest tokenem', () => {
    expect(parseInboxHandle(toInboxHandle(ID))).toBe(ID);
    expect(parseInboxHandle(`INV_${ID.toUpperCase()}`)).toBe(ID);

    for (const notHandle of [
      ID,
      `inv_${ID}x`,
      ` inv_${ID}`,
      'inv_not-a-uuid',
      'invite-home-demo',
      'a'.repeat(32),
    ]) {
      expect(parseInboxHandle(notHandle)).toBeNull();
    }
  });

  it('token szuka po haszu, uchwyt po id ORAZ adresacie', () => {
    expect(invitationLookup(USER, 'a'.repeat(32))).toEqual({
      tokenHash: hashInvitationToken('a'.repeat(32)),
    });
    expect(invitationLookup(USER, toInboxHandle(ID))).toEqual({
      id: ID,
      invitedUserId: USER,
    });
    // Samo id (bez prefiksu) to zwykły, nietrafiony token — nie skrót do wiersza.
    expect(invitationLookup(USER, ID)).toEqual({
      tokenHash: hashInvitationToken(ID),
    });
  });
});
