import { describe, expect, it } from 'vitest';
import { defaultRunId, ingestJobId, ingestPageDataSchema, type IngestPageData } from './job.js';

function data(overrides: Partial<IngestPageData> = {}): IngestPageData {
  return {
    runId: '2026-10-08',
    sicCodes: ['62011', '62012', '62020'],
    status: 'active',
    startIndex: 0,
    size: 500,
    maxPages: 2,
    ...overrides,
  };
}

describe('ingestPageDataSchema', () => {
  it('accepts a valid page', () => {
    expect(ingestPageDataSchema.parse(data())).toEqual(data());
  });

  it.each([
    ['no SIC codes (would mean every company)', { sicCodes: [] }],
    ['a SIC code that is not five digits', { sicCodes: ['6201'] }],
    ['a run id that would break the job id', { runId: 'a_b' }],
    ['a run id containing ":"', { runId: 'a:b' }],
    ['a negative start index', { startIndex: -1 }],
    ['a fractional start index', { startIndex: 0.5 }],
    ['a page size of zero', { size: 0 }],
    ['a page size above the Companies House maximum', { size: 5_001 }],
    ['zero pages', { maxPages: 0 }],
  ])('rejects %s', (_label, overrides) => {
    expect(ingestPageDataSchema.safeParse(data(overrides)).success).toBe(false);
  });
});

describe('ingestJobId', () => {
  it('is the same for the same page of the same run', () => {
    expect(ingestJobId(data())).toBe(ingestJobId(data()));
    expect(ingestJobId(data())).toBe('ingest_2026-10-08_62011-62012-62020_active_0');
  });

  it('ignores the order and repetition of SIC codes', () => {
    expect(ingestJobId(data({ sicCodes: ['62020', '62011', '62012', '62011'] }))).toBe(
      ingestJobId(data()),
    );
  });

  it.each([
    ['page', { startIndex: 500 }],
    ['run', { runId: '2026-10-09' }],
    ['status', { status: 'dissolved' }],
    ['SIC codes', { sicCodes: ['62011'] }],
  ])('differs for a different %s', (_label, overrides) => {
    expect(ingestJobId(data(overrides))).not.toBe(ingestJobId(data()));
  });

  it('never contains ":", which BullMQ rejects in custom ids', () => {
    expect(ingestJobId(data())).not.toContain(':');
  });
});

describe('defaultRunId', () => {
  it('is the UTC date, so late-evening UK runs in summer still share a day with UTC', () => {
    expect(defaultRunId(new Date('2026-10-08T23:59:59Z'))).toBe('2026-10-08');
    expect(defaultRunId(new Date('2026-07-01T23:30:00+01:00'))).toBe('2026-07-01');
  });
});
