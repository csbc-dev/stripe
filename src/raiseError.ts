export function raiseError(message: string): never {
  throw new Error(`[@csbc-dev/stripe] ${message}`);
}
