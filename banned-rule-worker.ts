export interface RegexCandidate {
  readonly index: number;
  readonly source?: string;
  readonly flags?: string;
}

const worker = self as unknown as {
  onmessage: (event: MessageEvent<{ text: string; rules: readonly RegexCandidate[] }>) => void;
  postMessage(result: number): void;
};

worker.onmessage = ({ data: { text, rules } }) => {
  for (const { index, source, flags } of rules) {
    if (source === undefined || new RegExp(source, flags).test(text)) {
      worker.postMessage(index);
      return;
    }
  }
  worker.postMessage(-1);
};
