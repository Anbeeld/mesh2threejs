import { stdin, stdout, stderr } from "node:process";
import { evaluateCriticPacket, type CriticPacket } from "./core/critic.js";

const chunks: Buffer[] = [];
stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
stdin.on("end", () => {
  try {
    const packet = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CriticPacket;
    stdout.write(`${JSON.stringify(evaluateCriticPacket(packet, true))}\n`);
  } catch (error) {
    stderr.write(`${String(error)}\n`);
    process.exitCode = 2;
  }
});
