import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A Debug Adapter Protocol proxy between an editor and lldb-dap that makes Abla values readable where lldb cannot
 * (no Python formatters in our repos): it rewrites the `variables` answers.
 *
 *  - `array<T>`: lldb shows a pointer to `{length, capacity, data}`. The element reads go through lldb's own
 *    `evaluate` (`*(T(*)[length])items->data`), so the elements arrive as children of the variable, typed and
 *    formatted by lldb, and the variable's value reads `length N`.
 *  - the universal value `{tag, flags, word0, word1}` (a nullable string, a Map, ...): its tag is read from memory;
 *    tag 1 is null, which lldb shows as `{}`. Other tags keep lldb's rendering with the tag named.
 *
 * Only the layout the compiler documents is read (docs/debugging.md, "Variables": the array header and the value
 * words; the tag meaning comes from the runtime's `__ablaRuntimeToString`). tools of the test suite fail when it drifts.
 */

export interface DapMessage { seq: number; type: string; command?: string; event?: string; request_seq?: number; success?: boolean; message?: string; body?: any; arguments?: any }

interface Variable { name: string; type?: string; value: string; variablesReference: number; evaluateName?: string; memoryReference?: string; presentationHint?: unknown }

const internalBase = 1_000_000_000;
/** The most elements one array shows (a longer one shows its first ones). */
export const arrayElementLimit = 200;

/** The tags of the universal value that the proxy names (runtime: `__ablaRuntimeTag`). */
export const valueTagNull = 1;

export class DapProxy {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private internalSeq = internalBase;
  private readonly clientRequests = new Map<number, { command: string; args: any }>();
  private readonly internal = new Map<number, (message: DapMessage) => void>();
  /** The frame each variables/scopes reference belongs to, so an evaluate runs in the right frame. */
  private readonly frameOf = new Map<number, number>();
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners: Array<(message: DapMessage) => void> = [];

  constructor(command: string, args: readonly string[] = [], options: { env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], detached: true, ...(options.env === undefined ? {} : { env: options.env }) });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/iu.exec(this.buffer.subarray(0, end).toString())?.[1]);
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()) as DapMessage;
        this.buffer = this.buffer.subarray(end + 4 + length);
        // The answers to the proxy's own questions must not wait behind the message that asked them.
        const own = message.type === "response" && message.request_seq !== undefined ? this.internal.get(message.request_seq) : undefined;
        if (own !== undefined) { this.internal.delete(message.request_seq as number); own(message); continue; }
        this.queue = this.queue.then(() => this.fromServer(message)).catch(() => undefined);
      }
    });
    this.child.stderr.on("data", () => undefined);
  }

  onMessage(listener: (message: DapMessage) => void): void { this.listeners.push(listener); }

  /** A message from the editor. */
  send(message: DapMessage): void {
    if (message.type === "request" && message.command !== undefined) {
      this.clientRequests.set(message.seq, { command: message.command, args: message.arguments });
    }
    this.write(message);
  }

  dispose(): void {
    try { if (this.child.pid !== undefined) process.kill(-this.child.pid, "SIGKILL"); } catch { this.child.kill(); }
  }

  private write(message: object): void {
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private deliver(message: DapMessage): void { for (const listener of this.listeners) listener(message); }

  private ask(command: string, args: object): Promise<DapMessage> {
    const seq = (this.internalSeq += 1);
    return new Promise((resolve) => {
      this.internal.set(seq, resolve);
      this.write({ seq, type: "request", command, arguments: args });
    });
  }

  private async fromServer(message: DapMessage): Promise<void> {
    if (message.type === "event" && (message.event === "stopped" || message.event === "continued" || message.event === "terminated")) this.frameOf.clear();
    if (message.type !== "response" || message.request_seq === undefined) { this.deliver(message); return; }
    const internal = this.internal.get(message.request_seq);
    if (internal !== undefined) { this.internal.delete(message.request_seq); internal(message); return; }
    const request = this.clientRequests.get(message.request_seq);
    this.clientRequests.delete(message.request_seq);
    if (message.success === true && request !== undefined) {
      if (request.command === "scopes") {
        for (const scope of message.body?.scopes ?? []) this.frameOf.set(scope.variablesReference, request.args?.frameId);
      } else if (request.command === "variables") {
        const frame = this.frameOf.get(request.args?.variablesReference);
        const variables = message.body?.variables as Variable[] | undefined;
        if (frame !== undefined && variables !== undefined) {
          for (const variable of variables) {
            if (variable.variablesReference > 0) this.frameOf.set(variable.variablesReference, frame);
            await this.decorate(variable, frame).catch(() => undefined);
          }
        }
      }
    }
    this.deliver(message);
  }

  private async evaluate(expression: string, frameId: number): Promise<{ result: string; type?: string; variablesReference: number } | undefined> {
    const reply = await this.ask("evaluate", { expression, frameId, context: "watch" });
    return reply.success === true ? reply.body : undefined;
  }

  private async decorate(variable: Variable, frame: number): Promise<void> {
    const expression = variable.evaluateName;
    if (expression === undefined) return;
    const array = /^array<(.*)> \*$/u.exec(variable.type ?? "");
    if (array !== null) {
      const length = await this.evaluate(`${expression}->length`, frame);
      const count = Number(length?.result);
      if (!Number.isInteger(count) || count < 0) return;
      variable.value = `length ${count}`;
      if (count === 0) { variable.variablesReference = 0; return; }
      const data = await this.evaluate(`${expression}->data`, frame);
      const element = data?.type?.replace(/ \*$/u, "");
      if (element === undefined) return;
      const shown = Math.min(count, arrayElementLimit);
      const elements = await this.evaluate(`*(${element}(*)[${shown}])${expression}->data`, frame);
      if (elements !== undefined && elements.variablesReference > 0) {
        this.frameOf.set(elements.variablesReference, frame);
        variable.variablesReference = elements.variablesReference;
        if (count > shown) variable.value = `length ${count} (first ${shown})`;
      }
      return;
    }
    if (variable.type === "value" && variable.memoryReference !== undefined) {
      const tag = await this.valueTag(variable.memoryReference);
      if (tag === valueTagNull) { variable.value = "null"; variable.variablesReference = 0; }
    }
  }

  /** The tag word of the universal value at `memoryReference` (its first four bytes). */
  private async valueTag(memoryReference: string): Promise<number | undefined> {
    const reply = await this.ask("readMemory", { memoryReference, count: 8 });
    if (reply.success !== true || typeof reply.body?.data !== "string") return undefined;
    return Buffer.from(reply.body.data, "base64").readUInt32LE(0);
  }
}
