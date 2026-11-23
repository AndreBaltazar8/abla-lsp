import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface DapMessage { seq: number; type: string; command?: string; event?: string; request_seq?: number; success?: boolean; message?: string; body?: any; }

/** A minimal Debug Adapter Protocol client over a child's stdio (lldb-dap, gdb -i dap). */
export class DapClient {
  readonly events: DapMessage[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private readonly waiting = new Map<number, (message: DapMessage) => void>();
  private readonly listeners: Array<() => void> = [];

  constructor(command: string, args: string[] = []) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/iu.exec(this.buffer.subarray(0, end).toString())?.[1]);
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()) as DapMessage;
        if (process.env.DAP_TRACE) console.log("DAP<", JSON.stringify(message).slice(0, 240));
        this.buffer = this.buffer.subarray(end + 4 + length);
        if (message.type === "response" && message.request_seq !== undefined) {
          this.waiting.get(message.request_seq)?.(message);
          this.waiting.delete(message.request_seq);
        } else if (message.type === "event") {
          this.events.push(message);
          for (const listener of this.listeners.splice(0)) listener();
        } else if (message.type === "request") {
          // A reverse request (runInTerminal): decline it.
          this.write({ seq: ++this.seq, type: "response", request_seq: message.seq, success: false, command: message.command });
        }
      }
    });
  }

  private write(message: object): void {
    const body = Buffer.from(JSON.stringify(message));
    if (process.env.DAP_TRACE) console.log("DAP>", body.toString().slice(0, 240));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(command: string, args: object = {}): Promise<DapMessage> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve);
      this.write({ seq, type: "request", command, arguments: args });
    });
  }

  /** The next event named `name` (including ones that came before this call and were not yet taken). */
  async event(name: string, timeoutMs = 30_000): Promise<DapMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.events.findIndex((event) => event.event === name);
      if (at >= 0) return this.events.splice(at, 1)[0] as DapMessage;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${name} event within ${timeoutMs} ms; saw ${JSON.stringify(this.events.map((event) => [event.event, event.body?.output ?? event.body?.reason]))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.listeners.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  /** Kills the adapter and the program under it (they share a process group, else the program keeps our pipes open). */
  stop(): void {
    try { if (this.child.pid !== undefined) process.kill(-this.child.pid, "SIGKILL"); } catch { this.child.kill(); }
  }
}

/** The same client interface over a DapProxy (src/dap-proxy.ts) instead of a bare adapter. */
export class ProxyClient {
  readonly events: DapMessage[] = [];
  private seq = 0;
  private readonly waiting = new Map<number, (message: DapMessage) => void>();
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly proxy: { send(message: any): void; onMessage(listener: (message: any) => void): void; dispose(): void }) {
    proxy.onMessage((message: DapMessage) => {
      if (message.type === "response" && message.request_seq !== undefined) {
        this.waiting.get(message.request_seq)?.(message);
        this.waiting.delete(message.request_seq);
      } else if (message.type === "event") {
        this.events.push(message);
        for (const listener of this.listeners.splice(0)) listener();
      }
    });
  }

  request(command: string, args: object = {}): Promise<DapMessage> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve);
      this.proxy.send({ seq, type: "request", command, arguments: args });
    });
  }

  async event(name: string, timeoutMs = 30_000): Promise<DapMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.events.findIndex((event) => event.event === name);
      if (at >= 0) return this.events.splice(at, 1)[0] as DapMessage;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${name} event within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.listeners.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  stop(): void { this.proxy.dispose(); }
}
