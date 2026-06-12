import type {
  AbortableNetworkResponse,
  NetworkRequestOptions,
} from "../types/net";

/**
 * Symbol-keyed abort controller, hidden from external callers.
 *
 * @internal
 */
export const ABORT_CONTROLLER = Symbol("abortController");

/**
 * Mutable request descriptor. Listeners on
 * `NETWORK_REQUEST` can modify {@link NetworkRequest.url},
 * {@link NetworkRequest.method}, {@link NetworkRequest.headers},
 * and {@link NetworkRequest.body} before each fetch attempt.
 *
 * @public
 */
export class NetworkRequest {
  /** HTTP method. Mutable before each attempt. */
  method: "GET" | "POST" = "GET";
  /** HTTP headers. Mutable before each attempt. */
  headers = new Headers();
  /** HTTP body. Mutable before each attempt. `null` for GET. */
  body: BodyInit | null = null;
  /** `true` while the request has not completed or been cancelled. */
  inFlight = true;
  /** Current attempt number (1-based after first fetch). */
  attempt = 0;
  /** @internal */
  [ABORT_CONTROLLER] = new AbortController();

  /**
   * @param url - Target URL. Mutable before each attempt.
   * @param promise - Resolves with the response or
   *   {@link ABORTED} if cancelled.
   * @param options - Retry and delay settings.
   */
  constructor(
    public url: string,
    public readonly promise: Promise<AbortableNetworkResponse>,
    public readonly options: NetworkRequestOptions = {
      maxAttempts: 1,
      delay: 0,
    },
  ) {}
}
