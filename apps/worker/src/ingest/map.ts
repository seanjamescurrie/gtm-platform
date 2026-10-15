import type { NewCompany, RegisteredAddress } from '@gtm/db';
import type { CompanySearchItem } from '@gtm/integrations';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Postgres stores absent address fields as missing keys, not as `undefined`.
function toRegisteredAddress(
  address: CompanySearchItem['registeredOfficeAddress'],
): RegisteredAddress | null {
  if (!address) return null;
  const present = Object.entries(address).filter(([, value]) => value !== undefined);
  // The two shapes share field names, so the remaining entries are already a RegisteredAddress.
  return present.length > 0 ? Object.fromEntries(present) : null;
}

/**
 * Wire shape (Companies House search item) to storage shape (a `companies` row).
 * Search items carry no etag or cessation date, so those columns are left unset.
 */
export function toNewCompany(item: CompanySearchItem): NewCompany {
  return {
    companyNumber: item.companyNumber,
    name: item.name,
    status: item.companyStatus,
    companyType: item.companyType,
    sicCodes: item.sicCodes,
    // One malformed date would make Postgres reject the whole page, so store null instead.
    incorporatedOn:
      item.dateOfCreation !== undefined && ISO_DATE.test(item.dateOfCreation)
        ? item.dateOfCreation
        : null,
    registeredAddress: toRegisteredAddress(item.registeredOfficeAddress),
  };
}
