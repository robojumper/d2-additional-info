import { PlatformErrorCodes, ServerResponse } from 'bungie-api-ts/common';
import { HttpClient, HttpClientConfig } from 'bungie-api-ts/http';

// All of this is just copied from DIM

export function createHttpClient(fetchFunction: typeof fetch, apiKey: string): HttpClient {
  return async (config: HttpClientConfig) => {
    let url = config.url;
    if (config.params) {
      // strip out undefined params keys. bungie-api-ts creates them for optional endpoint parameters
      for (const key in config.params) {
        typeof config.params[key] === 'undefined' && delete config.params[key];
      }
      url = `${url}?${new URLSearchParams(config.params as Record<string, string>).toString()}`;
    }

    const fetchOptions = new Request(url, {
      method: config.method,
      body: config.body ? JSON.stringify(config.body) : undefined,
      headers: { 'X-API-Key': apiKey, ...(config.body && { 'Content-Type': 'application/json' }) },
      credentials: 'omit',
    });

    const response = await fetchFunction(fetchOptions);
    let data: ServerResponse<unknown> | undefined;
    let parseError: Error | undefined;
    try {
      data = await response.json();
    } catch (e: any) {
      parseError = e;
    }
    // try throwing bungie errors, which have more information, first
    throwBungieError(data, fetchOptions);
    // then throw errors on generic http error codes
    throwHttpError(response);
    if (parseError) {
      throw parseError;
    }
    return data;
  };
}

/**
 * an error indicating a non-200 response code
 */
export class HttpStatusError extends Error {
  status: number;
  constructor(response: Response) {
    super(response.statusText);
    this.status = response.status;
  }
}

/**
 * an error indicating the Bungie API sent back a parseable response,
 * and that response indicated the request was not successful
 */
export class BungieError extends Error {
  code?: PlatformErrorCodes;
  status?: string;
  endpoint: string;
  constructor(response: Partial<ServerResponse<unknown>>, request: Request) {
    super(response.Message);
    this.name = 'BungieError';
    this.code = response.ErrorCode;
    this.status = response.ErrorStatus;
    this.endpoint = request.url;
  }
}

/**
 * this is a non-affecting pass-through for successful http requests,
 * but throws JS errors for a non-200 response
 */
function throwHttpError(response: Response) {
  if (response.status < 200 || response.status >= 400) {
    throw new HttpStatusError(response);
  }
  return response;
}

/**
 * sometimes what you have looks like a Response but it's actually an Error
 *
 * this is a non-affecting pass-through for successful API interactions,
 * but throws JS errors for "successful" fetches with Bungie error information
 */
function throwBungieError<T>(
  serverResponse: (ServerResponse<T> & { error?: string; error_description?: string }) | undefined,
  request: Request
) {
  // There's an alternate error response that can be returned during maintenance
  const eMessage = serverResponse?.error && serverResponse.error_description;
  if (eMessage) {
    throw new BungieError(
      {
        Message: eMessage,
        ErrorCode: PlatformErrorCodes.DestinyUnexpectedError,
        ErrorStatus: eMessage,
      },
      request
    );
  }

  if (serverResponse && serverResponse.ErrorCode !== PlatformErrorCodes.Success) {
    throw new BungieError(serverResponse, request);
  }

  return serverResponse;
}
