import { createAutoRepeat } from "./auto-repeat.ts";

let dispatch;

export function configureAutoRepeat({ sessionSignal, ...options }) {
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const observe = createAutoRepeat({ ...options, signal });
  const handler = event => observe(event, sessionSignal?.(event));
  dispatch = handler;
  return () => {
    lifetime.abort();
    if (dispatch === handler) dispatch = undefined;
  };
}

export class AutoRepeat extends plugin {
  constructor() {
    super({ name: "自动复读", event: "message.group", priority: -10000 });
  }

  async accept() {
    await dispatch?.(this.e);
    return false;
  }
}
