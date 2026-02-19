import { describe, expect, test } from "bun:test";
import { JsonLineWriter, type JsonLineWritable, writeJsonLine } from "../../packages/brewva-cli/src/json-lines.js";

class MemoryWritable implements JsonLineWritable {
  private readonly chunks: string[] = [];
  private readonly delays: number[];
  private callIndex = 0;

  constructor(delays: number[] = []) {
    this.delays = delays;
  }

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const delay = this.delays[this.callIndex] ?? 0;
    this.callIndex += 1;
    setTimeout(() => {
      this.chunks.push(chunk);
      callback?.(null);
    }, delay);
    return true;
  }

  output(): string {
    return this.chunks.join("");
  }
}

describe("json line output", () => {
  test("writeJsonLine writes one valid JSON object per line", async () => {
    const output = new MemoryWritable();
    await writeJsonLine({ k: "v", n: 1 }, output);
    const line = output.output();

    expect(line.endsWith("\n")).toBe(true);
    const decoded = JSON.parse(line.trim()) as { k: string; n: number };
    expect(decoded).toEqual({ k: "v", n: 1 });
  });

  test("JsonLineWriter serializes queued writes in call order", async () => {
    const output = new MemoryWritable([20, 0, 0]);
    const writer = new JsonLineWriter(output);

    writer.writeLine(JSON.stringify({ seq: 1 }));
    writer.writeLine(JSON.stringify({ seq: 2 }));
    writer.writeLine(JSON.stringify({ seq: 3 }));
    await writer.flush();

    const lines = output.output().trim().split("\n");
    const decoded = lines.map((line) => JSON.parse(line) as { seq: number });
    expect(decoded.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  test("JsonLineWriter surfaces write failures on flush", async () => {
    const output: JsonLineWritable = {
      write(_chunk: string, callback?: (error?: Error | null) => void): boolean {
        setTimeout(() => {
          callback?.(new Error("write_failed"));
        }, 0);
        return true;
      },
    };
    const writer = new JsonLineWriter(output);
    writer.writeLine(JSON.stringify({ fail: true }));

    await expect(writer.flush()).rejects.toThrow("write_failed");
  });
});

