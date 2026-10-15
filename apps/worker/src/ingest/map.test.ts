import type { CompanySearchItem } from '@gtm/integrations';
import { describe, expect, it } from 'vitest';
import { toNewCompany } from './map.js';

function item(overrides: Partial<CompanySearchItem> = {}): CompanySearchItem {
  return {
    name: 'UNOSQUARE LIMITED',
    companyNumber: 'NI642876',
    companyStatus: 'active',
    companyType: 'ltd',
    sicCodes: ['62012'],
    dateOfCreation: '2016-12-23',
    registeredOfficeAddress: {
      addressLine1: '1 Example Street',
      addressLine2: undefined,
      locality: 'Belfast',
      postalCode: 'BT1 3BG',
      country: undefined,
      region: undefined,
      premises: undefined,
    },
    ...overrides,
  };
}

describe('toNewCompany', () => {
  it('maps a search item to a companies row', () => {
    expect(toNewCompany(item())).toEqual({
      companyNumber: 'NI642876',
      name: 'UNOSQUARE LIMITED',
      status: 'active',
      companyType: 'ltd',
      sicCodes: ['62012'],
      incorporatedOn: '2016-12-23',
      registeredAddress: {
        addressLine1: '1 Example Street',
        locality: 'Belfast',
        postalCode: 'BT1 3BG',
      },
    });
  });

  it('drops address fields that are undefined rather than storing the keys', () => {
    const row = toNewCompany(item());
    expect(Object.keys(row.registeredAddress ?? {})).toEqual([
      'addressLine1',
      'locality',
      'postalCode',
    ]);
  });

  it('stores null when the address is missing or has no fields', () => {
    expect(toNewCompany(item({ registeredOfficeAddress: undefined })).registeredAddress).toBeNull();
    expect(
      toNewCompany(
        item({
          registeredOfficeAddress: {
            addressLine1: undefined,
            addressLine2: undefined,
            locality: undefined,
            postalCode: undefined,
            country: undefined,
            region: undefined,
            premises: undefined,
          },
        }),
      ).registeredAddress,
    ).toBeNull();
  });

  it.each([undefined, '', '23/12/2016', '2016-12-23T00:00:00Z'])(
    'stores a null incorporation date for %j',
    (dateOfCreation) => {
      expect(toNewCompany(item({ dateOfCreation })).incorporatedOn).toBeNull();
    },
  );

  it('keeps the company number as text, prefix and leading zeros included', () => {
    expect(toNewCompany(item({ companyNumber: '00012345' })).companyNumber).toBe('00012345');
  });

  it('leaves etag and cessation date unset: search items do not carry them', () => {
    const row = toNewCompany(item());
    expect(row).not.toHaveProperty('chEtag');
    expect(row).not.toHaveProperty('ceasedOn');
  });
});
