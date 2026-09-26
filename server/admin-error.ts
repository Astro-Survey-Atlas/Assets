export class AdminHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "AdminHttpError";
  }
}
