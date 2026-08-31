import http from "node:http";

/** 请求体上限。base64 编码的 5MB 附件约 6.7MB，10MB 留有余量。 */
export const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * 请求体超限。此前超限直接 `req.destroy()`，客户端只看到 `fetch failed`，
 * 没有任何可诊断信息；改为抛出本错误，由请求入口翻译成明确的 413。
 */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(
      `请求体过大（上限 ${Math.round(limitBytes / 1024 / 1024)}MB）。单个附件不能超过 5MB，请压缩或分批上传。`,
    );
    this.name = "RequestBodyTooLargeError";
  }
}

export function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodySize = 0;
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      // 超限后停止累积，不再把整个超大 body 拉进内存。
      if (tooLarge) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        tooLarge = true;
        body = "";
        reject(new RequestBodyTooLargeError(MAX_BODY_SIZE));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
