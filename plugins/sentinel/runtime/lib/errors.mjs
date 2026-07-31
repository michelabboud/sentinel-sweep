export class SentinelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SentinelError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
