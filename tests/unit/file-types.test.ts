import { describe, expect, it } from 'vitest';
import { resolveContentType } from '@/modules/platform/files/service';

describe('resolveContentType', () => {
  it('keeps a real content type as-is', () => {
    expect(resolveContentType('a.pdf', 'application/pdf')).toBe('application/pdf');
  });

  it('falls back to the extension when the browser sends nothing', () => {
    expect(resolveContentType('invoice.XLSX', '')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(resolveContentType('archive.rar', 'application/octet-stream')).toBe(
      'application/vnd.rar',
    );
    expect(resolveContentType('видео.mp4', '')).toBe('video/mp4');
  });

  it('leaves unknown extensions untouched (rejected later with a clear code)', () => {
    expect(resolveContentType('tool.exe', '')).toBe('');
  });
});
