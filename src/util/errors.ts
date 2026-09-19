/** Base class for all errors readme-sync raises deliberately. */
export class ReadmeSyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReadmeSyncError';
    this.code = code;
  }
}

/** Marker structure in a README is invalid. The tool must touch nothing. */
export class MarkerError extends ReadmeSyncError {
  constructor(message: string) {
    super('MARKER', message);
    this.name = 'MarkerError';
  }
}

export class ConfigError extends ReadmeSyncError {
  constructor(message: string) {
    super('CONFIG', message);
    this.name = 'ConfigError';
  }
}

export class GitError extends ReadmeSyncError {
  constructor(message: string) {
    super('GIT', message);
    this.name = 'GitError';
  }
}
