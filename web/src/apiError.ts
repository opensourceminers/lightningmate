/**
 * A non-2xx answer from the API: the message to show, plus the status and
 * the body, for the callers that act on a particular refusal (e.g. a spend
 * of coins promised to buyers, which can be confirmed and sent again).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
