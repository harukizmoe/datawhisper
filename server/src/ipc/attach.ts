/** 把服务接到一对流上：stdin 读请求，stdout 只写 JSON-RPC 记录（日志走 stderr）。 */
import { loadConfig } from "../config.ts";
import { feishuService } from "../feishu/service.ts";
import type { Service } from "../service.ts";
import { JsonLinesDecoder, JsonlWriter, streamLineSink } from "./framing.ts";
import { createMethods, mapSettingsError } from "./methods.ts";
import { RpcServer } from "./rpc.ts";

export type IpcStreams = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };

export type AttachOptions = {
  /** stdin 结束时调用（主进程据此有序退出）；测试里不传，管道关闭只代表客户端走了。 */
  onInputEnd?: () => void;
  log?: (message: string, error?: unknown) => void;
  /**
   * 应用数据目录（飞书配置、绑定与幂等账本所在）。默认取 `loadConfig()`，与 `main.ts` 启动服务时同一个
   * 环境变量契约；测试传临时目录，避免碰用户目录。
   */
  dataDir?: string;
  /**
   * 挂上后立即按配置启动长连接（生产默认）。进程内测试传 false，避免沿用用户目录里已启用的
   * 飞书配置去连真实网络；需要长连接测试时直接驱动 `FeishuService`。
   */
  autoStartFeishu?: boolean;
};

/** 把服务接到流上；stdin 结束（EOF 或出错）时调用 `onInputEnd`。 */
export function attachIpc(service: Service, { input, output }: IpcStreams, options: AttachOptions = {}): void {
  const log = options.log ?? ((message: string, error?: unknown) => console.error(`[ipc] ${message}`, error));
  // 飞书机器人：入站回合走 `conversations.submitTurn`；状态变化经同一条通知通道推给界面。
  const feishu = feishuService({ dataDir: options.dataDir ?? loadConfig().dataDir, log: (message, error) => log(message, error) });
  feishu.attachRuntime({
    conversations: service.conversations,
    harness: service.harness,
    context: service.context,
  });
  const writer = new JsonlWriter(streamLineSink(output));
  // 订阅的推送要经过 RpcServer（唯一负责记录形状的地方），而方法表又要先于它构造，
  // 因此这里用一个先占位、构造完成后接上的委托。
  let notify: (method: string, params: unknown) => Promise<void> = () => Promise.resolve();
  const server = new RpcServer({
    methods: createMethods({
      harness: service.harness,
      compute: service.compute,
      modelService: service.modelService,
      conversations: service.conversations,
      context: service.context,
      publish: (event) => notify("conversation.event", event),
      feishu,
      dataDir: options.dataDir ?? loadConfig().dataDir,
      sourceMethods: service.sourceMethods,
    }),
    send: (record) => writer.send(record),
    mapError: mapSettingsError,
    log,
  });
  notify = (method, params) => server.notify(method, params);

  // 接上真实的通知通道之后才订阅状态并启动：否则启动瞬间的状态变化会被占位委托吞掉。
  const unsubscribeFeishu = feishu.onStatusChange((status) => {
    void notify("feishu.status", status).catch((error: unknown) => log("推送飞书状态失败", error));
  });
  if (options.autoStartFeishu !== false) void feishu.start();
  void service.closed.then(() => {
    unsubscribeFeishu();
    void feishu.stop();
  });

  const decoder = new JsonLinesDecoder();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    options.onInputEnd?.();
  };

  input.on("data", (chunk: Uint8Array | string) => {
    for (const line of decoder.push(chunk)) {
      // 每条记录独立执行：慢请求不能挡住后面的请求，响应按 id 配对、允许乱序。
      void server.handleLine(line).catch((error: unknown) => {
        log("处理记录失败", error);
      });
    }
  });
  input.on("end", end);
  // 管道被销毁时不一定有 `end`；`close` 也要当成「父进程走了」。
  input.on("close", end);
  input.on("error", (error: Error) => {
    log("读取 stdin 失败", error);
    end();
  });
}
