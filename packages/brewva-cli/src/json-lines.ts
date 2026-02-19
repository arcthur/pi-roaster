export type JsonLineWritable = {
  write(
    chunk: string,
    callback?: (error?: Error | null) => void,
  ): boolean;
};

function writeChunk(
  output: JsonLineWritable,
  chunk: string,
): Promise<void> {
  return new Promise<void>((resolveWrite, rejectWrite) => {
    output.write(chunk, (error?: Error | null) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}

export class JsonLineWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly output: JsonLineWritable = process.stdout,
  ) {}

  writeLine(line: string): void {
    this.queue = this.queue.then(() => writeChunk(this.output, `${line}\n`));
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

export async function writeJsonLine(
  value: unknown,
  output: JsonLineWritable = process.stdout,
): Promise<void> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return;
  await writeChunk(output, `${encoded}\n`);
}

