#!/usr/bin/env node
/**
 * 测试用的最小 MCP 服务:stdio 上的按行 JSON-RPC。
 *
 * 它只实现 mastic 会用到的那几个方法,外加两个故意出错的工具 ——
 * 能跑通只是及格,能说清楚怎么坏才算被测到了。
 */
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const tools = [
  {
    name: "echo",
    description: "原样返回文本",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "add",
    description: "两数相加",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "pixels",
    description: "返回一张（假）图",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "boom",
    description: "总是返回 isError",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "server_request",
    description: "先向客户端发一个请求，再正常返回",
    inputSchema: { type: "object", properties: {} },
  },
];

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "0.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === "echo") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] } });
      return;
    }

    if (name === "add") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] },
      });
      return;
    }

    if (name === "pixels") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: "图来了" },
            { type: "image", data: Buffer.from("not-really-a-png").toString("base64"), mimeType: "image/png" },
          ],
        },
      });
      return;
    }

    if (name === "boom") {
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "炸了" }] } });
      return;
    }

    if (name === "server_request") {
      // 服务端发起的请求:客户端必须回一个错误,否则这里就会一直等
      send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list", params: {} });
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "sent" }] } });
      return;
    }

    send({ jsonrpc: "2.0", id, error: { code: -32602, message: `没有工具 ${name}` } });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
