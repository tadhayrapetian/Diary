// Just enough of node:events for the demo mailbox to run in a browser.
export class EventEmitter {
  #handlers = new Map();
  on(name, fn) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, new Set());
    this.#handlers.get(name).add(fn);
    return this;
  }
  once(name, fn) {
    const wrap = (...args) => {
      this.#handlers.get(name)?.delete(wrap);
      fn(...args);
    };
    return this.on(name, wrap);
  }
  emit(name, ...args) {
    for (const fn of [...(this.#handlers.get(name) || [])]) fn(...args);
    return true;
  }
}
