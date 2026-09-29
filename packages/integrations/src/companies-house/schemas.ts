import { z } from 'zod';

const registeredOfficeAddressSchemaResponse = z.object({
  address_line_1: z.string().optional(),
  address_line_2: z.string().optional(),
  country: z.string().optional(),
  locality: z.string().optional(),
  postal_code: z.string().optional(),
  region: z.string().optional(),
  premises: z.string().optional(),
});

// Fields shared by advanced-search items and company profiles. The two endpoints name the
// company type differently (`company_type` vs `type`), so each extends this base with its own.
// zod strips unknown keys by default, which drops the many Companies House fields we don't use.
const companyBaseSchema = z.object({
  company_name: z.string(),
  company_number: z.string(),
  company_status: z.string(),
  registered_office_address: registeredOfficeAddressSchemaResponse.optional(),
  date_of_creation: z.string().optional(),
  sic_codes: z.array(z.string()).default([]),
});

type CompanyBase = z.infer<typeof companyBaseSchema>;

// The camelCase fields common to both outputs; each schema adds its own fields on top.
function toCompanyFields(data: CompanyBase) {
  return {
    name: data.company_name,
    companyNumber: data.company_number,
    companyStatus: data.company_status,
    registeredOfficeAddress: data.registered_office_address
      ? {
          addressLine1: data.registered_office_address.address_line_1,
          addressLine2: data.registered_office_address.address_line_2,
          locality: data.registered_office_address.locality,
          postalCode: data.registered_office_address.postal_code,
          country: data.registered_office_address.country,
          region: data.registered_office_address.region,
          premises: data.registered_office_address.premises,
        }
      : undefined,
    dateOfCreation: data.date_of_creation,
    sicCodes: data.sic_codes,
  };
}

// One item in GET /advanced-search/companies.
export const companySearchItemSchema = companyBaseSchema
  .extend({ company_type: z.string() })
  .transform((data) => ({ ...toCompanyFields(data), companyType: data.company_type }));

// GET /advanced-search/companies. A search with no matches is an HTTP 404 with an empty body,
// not a 200 with hits: 0, so the client handles that case before parsing.
export const advancedSearchPageSchema = z.object({
  hits: z.number(),
  items: z.array(companySearchItemSchema),
});

// GET /company/{companyNumber}. The etag feeds companies.ch_etag for skip-if-unchanged upserts.
export const companyProfileSchema = companyBaseSchema
  .extend({ type: z.string(), etag: z.string() })
  .transform((data) => ({ ...toCompanyFields(data), companyType: data.type, etag: data.etag }));

export type CompanySearchItem = z.infer<typeof companySearchItemSchema>;
export type AdvancedSearchPage = z.infer<typeof advancedSearchPageSchema>;
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
