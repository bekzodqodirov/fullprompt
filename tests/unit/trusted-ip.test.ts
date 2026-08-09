import { describe, expect, it } from 'vitest';
import { trustedIpFrom } from '@/modules/platform/auth/session';

/**
 * `X-Forwarded-For` is written by the caller and appended to by every hop, so
 * only the entry OUR OWN proxy added can be believed.
 *
 * This used to read the leftmost element, which is the one the client sends.
 * The consequence was not cosmetic: the login limiter counted the
 * (identifier, ip) pair, so rotating this header gave an attacker a fresh
 * bucket per attempt and one staff password could be guessed without limit.
 */
describe('the address we are willing to believe', () => {
  it('takes the hop our own proxy appended, not the one the caller wrote', () => {
    // A caller who invents two hops before reaching Caddy; Caddy appends the
    // address it actually saw.
    expect(trustedIpFrom('11.11.11.11, 22.22.22.22, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('reads a single-hop header as itself', () => {
    expect(trustedIpFrom('203.0.113.9')).toBe('203.0.113.9');
  });

  it('says «unknown» rather than inventing one', () => {
    // No header means the app was reached without the proxy at all. A number
    // nobody stands behind is worse than nothing, because it would be written
    // into sessions.ip and into the audit trail as if it were a fact.
    expect(trustedIpFrom(null)).toBeNull();
    expect(trustedIpFrom('')).toBeNull();
    expect(trustedIpFrom('   ')).toBeNull();
    expect(trustedIpFrom(', ,')).toBeNull();
  });

  it('tolerates the spacing real proxies produce', () => {
    expect(trustedIpFrom('11.11.11.11,203.0.113.9')).toBe('203.0.113.9');
    expect(trustedIpFrom('  11.11.11.11 ,  203.0.113.9  ')).toBe('203.0.113.9');
  });
});
