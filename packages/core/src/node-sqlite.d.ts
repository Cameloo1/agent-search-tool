declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): Record<string, unknown> | undefined;
      all(...params: unknown[]): Array<Record<string, unknown>>;
    };
    close(): void;
  }
}
