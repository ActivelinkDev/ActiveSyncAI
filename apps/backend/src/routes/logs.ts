import { Router } from "express";
import { logEvents } from "../utils/logger";

const router = Router();

router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const onLog = (line: string) => {
    res.write(`data: ${line}\n\n`);
  };

  logEvents.on("line", onLog);

  req.on("close", () => {
    logEvents.off("line", onLog);
  });
});

export default router;
