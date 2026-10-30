import { Agent, type Dispatcher } from "undici";

/** One source request owns this transport. Never alter the shared dispatcher.
 * Fetch implementations may supply their own timeout options, so apply the
 * admitted limit at dispatch as well as keeping the outer absolute deadline. */
export class AiSourceDispatcher extends Agent {
  constructor(private readonly milliseconds: number) {
    super({ connections: 1, pipelining: 1 });
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return super.dispatch({ ...options, headersTimeout: this.milliseconds, bodyTimeout: this.milliseconds }, handler);
  }
}
