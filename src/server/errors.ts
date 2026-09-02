/** Structured error the runtime returns instead of leaking a stack trace. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  toResponse(): Response {
    return Response.json(
      { error: this.code, message: this.message },
      { status: this.status },
    );
  }
}

export const notFound = (code: string, message: string) => new HttpError(404, code, message);
export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const forbidden = (message: string) => new HttpError(403, "forbidden", message);
