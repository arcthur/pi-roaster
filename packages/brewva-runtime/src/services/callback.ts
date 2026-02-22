export type RuntimeCallback<Args extends unknown[] = [], Result = void> = (
  this: void,
  ...args: Args
) => Result;
