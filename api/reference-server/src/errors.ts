/** The API error envelope's carrier; the error handler in index.ts turns it into `{ error: { type, code, message, ... } }`. */
export class ApiError extends Error {
  constructor(public status: number, public type: string, public code: string, message: string, public param?: string, public details?: Record<string, unknown>) { super(message); }
}
