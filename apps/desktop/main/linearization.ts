export interface LinearizationGate {
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export class SerialLinearizationGate implements LinearizationGate {
  #tail = Promise.resolve();

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
