import { groupRequestReview } from "./request-review.ts";

export class ReviewGroupRequest extends plugin {
  constructor() {
    super({ name: "群请求审核", event: "request.group" });
  }

  async accept() {
    const receive = () => groupRequestReview.receive(this.e);
    if (this.e.deferManualReview) this.e.deferManualReview(receive);
    else await receive();
    // Observing the request does not take it away from other handlers.
    return false;
  }
}
