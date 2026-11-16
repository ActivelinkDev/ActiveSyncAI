import { EventEmitter } from "events";

export const logEvents = new EventEmitter();

export function logLine(...args: any[]) {
  const line = args.map(a =>
    typeof a === "object" ? JSON.stringify(a) : String(a)
  ).join(" ");

  console.log(line);
  logEvents.emit("line", line);
}
