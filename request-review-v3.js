import { groupRequestReview } from "./request-review.ts";

export class ReviewGroupRequest extends plugin {
  constructor() {
    super({ name: "群请求审核", event: "request.group" });
  }

  async accept() {
    await groupRequestReview.receive(this.e);
    // Observing the request does not take it away from other handlers.
    return false;
  }
}
