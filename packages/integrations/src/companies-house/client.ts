import type { Logger } from 'pino';
import { CompaniesHouseError, errorFromResponse } from './errors.js';
import {
  advancedSearchPageSchema,
  companyProfileSchema,
  type AdvancedSearchPage,
  type CompanyProfile,
} from './schemas.js';
import type { z } from 'zod';

export type CompaniesHouseClientOptions = {
  apiKey: string;
  logger: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

export type AdvancedSearchQuery = {
  companyNameIncludes?: string;
  sicCodes: string[];
  status?: string;
  size?: number;
  startIndex?: number;
  incorporatedFrom?: string;
};

export class CompaniesHouseClient {
  private logger: Logger;
  private fetch: typeof fetch;
  private baseUrl: string;
  private timeoutMs: number;
  private authorization: string;
  private static defaultBaseUrl = 'https://api.company-information.service.gov.uk';

  constructor({ apiKey, logger, fetch, baseUrl, timeoutMs }: CompaniesHouseClientOptions) {
    this.logger = logger;
    this.fetch = fetch ?? globalThis.fetch;
    this.baseUrl = baseUrl ?? CompaniesHouseClient.defaultBaseUrl;
    this.timeoutMs = timeoutMs ?? 10_000;
    // Built once; the raw key isn't kept on the object.
    this.authorization = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  }

  private async companiesHouseHttpClient<S extends z.ZodType>({
    path,
    query,
    schema,
  }: {
    path: string;
    query?: URLSearchParams;
    schema: S;
  }) {
    const url = new URL(path, this.baseUrl);
    const where = `GET ${path}`;
    let response: Response;
    const perf = performance.now();

    if (query) {
      url.search = query.toString();
    }
    try {
      response = await this.fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: this.authorization,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw CompaniesHouseError.timeout(where, error);
      }
      throw CompaniesHouseError.network(where, error);
    }
    // Check for null before converting: Number(null) is 0, which would read as "rate limit exhausted".
    const remain = response.headers.get('x-ratelimit-remain');
    this.logger.info(
      {
        method: 'GET',
        path,
        status: response.status,
        durationMs: Math.round(performance.now() - perf),
        rateLimitRemain: remain === null ? undefined : Number(remain),
      },
      'companies house request',
    );

    if (response.status === 404) return null;

    const error = errorFromResponse(response.status, response.headers, where);
    if (error) throw error;

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw CompaniesHouseError.invalidResponse(where, error);
    }

    const parsedResponse = schema.safeParse(body);
    if (!parsedResponse.success) {
      throw CompaniesHouseError.invalidResponse(where, parsedResponse.error);
    }

    return parsedResponse.data;
  }

  async getCompanyProfile(companyNumber: string): Promise<CompanyProfile | null> {
    const response: CompanyProfile | null = await this.companiesHouseHttpClient({
      path: `/company/${encodeURIComponent(companyNumber)}`,
      schema: companyProfileSchema,
    });

    return response;
  }

  async advancedSearch(queryParams: AdvancedSearchQuery): Promise<AdvancedSearchPage> {
    const params = new URLSearchParams();
    if (queryParams.companyNameIncludes !== undefined)
      params.set('company_name_includes', queryParams.companyNameIncludes);
    if (queryParams.incorporatedFrom !== undefined)
      params.set('incorporated_from', queryParams.incorporatedFrom);
    // Deliberate: an empty sicCodes list means "no SIC filter" (all companies), not an error.
    if (queryParams.sicCodes.length > 0) params.set('sic_codes', queryParams.sicCodes.join(','));
    if (queryParams.size !== undefined) params.set('size', queryParams.size.toString());
    if (queryParams.status !== undefined) params.set('company_status', queryParams.status);
    if (queryParams.startIndex !== undefined)
      params.set('start_index', queryParams.startIndex.toString());

    const response: AdvancedSearchPage | null = await this.companiesHouseHttpClient({
      path: '/advanced-search/companies',
      query: params,
      schema: advancedSearchPageSchema,
    });

    return response ?? { hits: 0, items: [] };
  }
}
