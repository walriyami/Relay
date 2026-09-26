/** An error whose message is safe to show the user, with the HTTP status to send. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
export const notFound = (what = "That"): never => fail(404, `${what} was not found.`);
