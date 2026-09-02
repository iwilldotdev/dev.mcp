export function toAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((block) => ({
    type: "paragraph",
    content: block
      ? block.split("\n").flatMap((line, index, arr) => {
          const nodes: unknown[] = [{ type: "text", text: line }];
          if (index < arr.length - 1) nodes.push({ type: "hardBreak" });
          return nodes;
        })
      : [],
  }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }],
  };
}

export function maybeAdf(value: unknown): unknown {
  if (typeof value === "string") return toAdf(value);
  return value;
}
