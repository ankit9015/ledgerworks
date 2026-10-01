/** An error whose message is safe to show to API clients. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (): ApiError =>
  new ApiError(401, 'unauthorized', 'Missing or invalid credentials');
