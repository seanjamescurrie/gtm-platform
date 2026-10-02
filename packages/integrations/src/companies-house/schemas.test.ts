import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { advancedSearchPageSchema, companyProfileSchema } from './schemas.js';

// Fixtures are real Companies House responses. Parsing them as `unknown` is deliberate:
// the schema, not the test, is what turns them into typed values.
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
}

// Cloning lets a test delete fields from a real fixture without affecting other tests.
function cloneFixture<T>(name: string): T {
  return structuredClone(loadFixture(name)) as T;
}

// Every key at every depth, to check nothing Companies House-shaped leaks out.
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
  }
  return [];
}

type RawItem = Record<string, unknown>;
type RawPage = { items: RawItem[] };

describe('advancedSearchPageSchema', () => {
  it('parses a real advanced search page', () => {
    const page = advancedSearchPageSchema.parse(loadFixture('advanced-search.json'));

    expect(page.hits).toBe(5513772);
    expect(page.items).toHaveLength(3);
  });

  it('maps an item to camelCase, keeping every address field that is present', () => {
    const [first] = advancedSearchPageSchema.parse(loadFixture('advanced-search.json')).items;

    expect(first).toEqual({
      name: 'CROWN OVERSEAS SERVICES LIMITED',
      companyNumber: 'NI019095',
      companyStatus: 'active',
      companyType: 'ltd',
      dateOfCreation: '1986-01-16',
      sicCodes: ['27900'],
      registeredOfficeAddress: {
        addressLine1: 'Unit 12',
        addressLine2: 'Graham Industrial Park',
        locality: 'Dargan Crescent',
        region: 'Belfast',
        postalCode: 'BT3 9JP',
      },
    });
  });

  it('defaults sicCodes to [] when Companies House omits sic_codes', () => {
    const { items } = advancedSearchPageSchema.parse(loadFixture('advanced-search.json'));

    // NI020744 and NI025749 have no sic_codes in the real response.
    expect(items[1]?.sicCodes).toEqual([]);
    expect(items[2]?.sicCodes).toEqual([]);
  });

  it('accepts sparse real addresses (no country, no locality, no region)', () => {
    const { items } = advancedSearchPageSchema.parse(loadFixture('advanced-search.json'));

    expect(items[2]?.registeredOfficeAddress).toEqual({
      addressLine1: '40 University Street',
      addressLine2: 'Belfast',
      postalCode: 'BT7 1FZ',
    });
  });

  it('accepts an item without date_of_creation or registered_office_address', () => {
    const page = cloneFixture<RawPage>('advanced-search.json');
    delete page.items[0]?.date_of_creation;
    delete page.items[0]?.registered_office_address;

    const [first] = advancedSearchPageSchema.parse(page).items;

    expect(first?.dateOfCreation).toBeUndefined();
    expect(first?.registeredOfficeAddress).toBeUndefined();
    expect(first?.companyNumber).toBe('NI019095');
  });

  it('drops Companies House-only fields (kind, links, etag, top_hit) and all snake_case keys', () => {
    const page = advancedSearchPageSchema.parse(loadFixture('advanced-search.json'));
    const keys = allKeys(page);

    expect(keys).not.toContain('kind');
    expect(keys).not.toContain('links');
    expect(keys).not.toContain('top_hit');
    expect(keys.filter((key) => key.includes('_'))).toEqual([]);
  });

  it('rejects an item without company_number, pointing at the field', () => {
    const page = cloneFixture<RawPage>('advanced-search.json');
    delete page.items[1]?.company_number;

    const result = advancedSearchPageSchema.safeParse(page);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([
      'items',
      1,
      'company_number',
    ]);
  });

  it('rejects a page without items', () => {
    const page = cloneFixture<Record<string, unknown>>('advanced-search.json');
    delete page.items;

    expect(advancedSearchPageSchema.safeParse(page).success).toBe(false);
  });
});

describe('companyProfileSchema', () => {
  it('parses a real profile, reading the company type from `type` and keeping the etag', () => {
    const profile = companyProfileSchema.parse(loadFixture('company-profile.json'));

    expect(profile).toEqual({
      name: 'UNOSQUARE LIMITED',
      companyNumber: 'NI642876',
      companyStatus: 'active',
      companyType: 'ltd',
      dateOfCreation: '2016-12-23',
      sicCodes: ['62012'],
      registeredOfficeAddress: {
        addressLine1: '17 Clarendon Road Clarendon Dock',
        locality: 'Belfast',
        postalCode: 'BT1 3BG',
        country: 'United Kingdom',
      },
      etag: expect.any(String) as string,
    });
  });

  it('parses a real profile with no sic_codes, defaulting sicCodes to []', () => {
    const profile = companyProfileSchema.parse(loadFixture('company-profile-no-sic.json'));

    expect(profile.companyNumber).toBe('NI017846');
    expect(profile.companyStatus).toBe('liquidation');
    expect(profile.sicCodes).toEqual([]);
  });

  it('drops the many profile fields we do not use, and all snake_case keys', () => {
    const profile = companyProfileSchema.parse(loadFixture('company-profile-no-sic.json'));
    const keys = allKeys(profile);

    for (const unused of ['accounts', 'links', 'jurisdiction', 'previous_company_names']) {
      expect(keys).not.toContain(unused);
    }
    expect(keys.filter((key) => key.includes('_'))).toEqual([]);
  });

  it('rejects a profile without company_number, pointing at the field', () => {
    const profile = cloneFixture<RawItem>('company-profile.json');
    delete profile.company_number;

    const result = companyProfileSchema.safeParse(profile);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(['company_number']);
  });

  it('does not accept a 404 body as a profile, so the client must decide on 404 from the status', () => {
    // The real 404 body is { timestamp, message, request_id }, not the documented `errors` array.
    expect(companyProfileSchema.safeParse(loadFixture('not-found.json')).success).toBe(false);
  });
});
