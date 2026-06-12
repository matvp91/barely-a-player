import { Events } from "../events";
import type { Player } from "../player";
import type {
  AbortableNetworkResponse,
  NetworkRequestOptions,
  NetworkRequestType,
} from "../types/net";
import { ABORTED } from "../types/net";
import { ABORT_CONTROLLER, NetworkRequest } from "./network_request";
import { NetworkResponse } from "./network_response";

/**
 * Central service for all network requests. Owns fetch execution,
 * retry logic, and cancellation.
 *
 * @public
 */
export class NetworkService {
  private requests_ = new Set<NetworkRequest>();

  constructor(private player_: Player) {}

  /**
   * Creates and starts an HTTP request. Emits
   * `NETWORK_REQUEST` before each attempt,
   * allowing listeners to mutate the request URL, headers,
   * and method.
   */
  request(
    type: NetworkRequestType,
    url: string,
    options?: NetworkRequestOptions,
    init?: {
      method?: "GET" | "POST";
      headers?: Headers;
      body?: BodyInit | null;
    },
  ): NetworkRequest {
    const promise = Promise.withResolvers<AbortableNetworkResponse>();
    const request = new NetworkRequest(url, promise.promise, options);
    if (init?.method) {
      request.method = init.method;
    }
    if (init?.headers) {
      request.headers = init.headers;
    }
    if (init?.body !== undefined) {
      request.body = init.body;
    }

    this.fetchWithRetry_(type, request, promise);

    return request;
  }

  /**
   * Aborts an in-flight request. No-op if already completed or
   * cancelled.
   */
  cancel(request: NetworkRequest) {
    request.inFlight = false;
    request[ABORT_CONTROLLER].abort();
    this.requests_.delete(request);
  }

  private async fetchWithRetry_(
    type: NetworkRequestType,
    request: NetworkRequest,
    promise: PromiseWithResolvers<AbortableNetworkResponse>,
  ) {
    this.requests_.add(request);

    const { maxAttempts } = request.options;
    try {
      while (request.attempt < maxAttempts) {
        // Prepare the request for the next attempt.
        request.attempt += 1;
        request[ABORT_CONTROLLER] = new AbortController();

        const done = await this.fetchAttempt_(type, request, promise);
        if (done) {
          // If we're done, break out of the while loop.
          break;
        }
      }
    } finally {
      request.inFlight = false;
      this.requests_.delete(request);
    }
  }

  /**
   * Executes a single fetch attempt with error handling.
   * Returns `true` when the promise has been settled (success
   * or terminal error), `false` to retry.
   */
  private async fetchAttempt_(
    type: NetworkRequestType,
    request: NetworkRequest,
    promise: PromiseWithResolvers<AbortableNetworkResponse>,
  ): Promise<boolean> {
    try {
      const data = await this.fetchRequest_(type, request);
      promise.resolve(data);
      return true;
    } catch (error) {
      if (this.handleFetchError_(error, request, promise)) {
        return true;
      }

      // TODO(matvp): Make this a helper, or maybe migrate to
      // new Timer?
      await new Promise((resolve) =>
        setTimeout(resolve, request.options.delay),
      );
      return false;
    }
  }

  /**
   * Handles a fetch error. Returns true if the error was terminal
   * (abort or final attempt), false if the caller should retry.
   */
  private handleFetchError_(
    error: unknown,
    request: NetworkRequest,
    promise: PromiseWithResolvers<AbortableNetworkResponse>,
  ): boolean {
    if (error instanceof DOMException && error.name === "AbortError") {
      // Resolve with the sentinel so callers know that the request
      // got aborted and can bail out.
      promise.resolve(ABORTED);
      return true;
    }

    if (request.attempt >= request.options.maxAttempts) {
      promise.reject(error);
      return true;
    }

    return false;
  }

  /**
   * Executes a single fetch attempt. Emits request/response events.
   */
  private async fetchRequest_(
    type: NetworkRequestType,
    request: NetworkRequest,
  ): Promise<NetworkResponse> {
    this.player_.emit(Events.NETWORK_REQUEST, { type, request });

    const startTime = performance.now();
    const res = await this.fetch_(request);
    const data = await res.arrayBuffer();

    const response = new NetworkResponse(
      request,
      res.status,
      res.headers,
      startTime,
      data,
    );

    this.player_.emit(Events.NETWORK_RESPONSE, { type, response });

    return response;
  }

  /**
   * Native fetch, throws when not 2xx.
   * TODO(matvp): Once we have custom errors, throw a NetworkError.
   */
  private async fetch_(request: NetworkRequest): Promise<Response> {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request[ABORT_CONTROLLER].signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return res;
  }
}
