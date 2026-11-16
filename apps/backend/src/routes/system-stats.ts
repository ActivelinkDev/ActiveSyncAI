import { Router } from "express";
import * as os from "os";
import { getShopifyStore, SHOPIFY_API_VERSION } from "../suprides/api/shopify-api";
import { getSchedulerConfig } from "../services/scheduler";

const router = Router();

function cpuPercent(): Promise<number> {
  return new Promise((resolve) => {
    const t1 = os.cpus().map(c => c.times);
    setTimeout(() => {
      const t2 = os.cpus().map(c => c.times);
      let idle = 0, total = 0;
      for (let i = 0; i < t1.length; i++) {
        const d = {
          user:   t2[i].user   - t1[i].user,
          nice:   t2[i].nice   - t1[i].nice,
          sys:    t2[i].sys    - t1[i].sys,
          idle:   t2[i].idle   - t1[i].idle,
          irq:    t2[i].irq    - t1[i].irq,
        };
        const tot = d.user + d.nice + d.sys + d.idle + d.irq;
        idle  += d.idle;
        total += tot;
      }
      resolve(total ? Math.round((1 - idle / total) * 100) : 0);
    }, 200);
  });
}

router.get("/", async (_req, res) => {
  const [cpuPct] = await Promise.all([cpuPercent()]);

  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const mem = {
    totalMb: Math.round(totalMem / 1024 / 1024),
    usedMb:  Math.round(usedMem  / 1024 / 1024),
    freeMb:  Math.round(freeMem  / 1024 / 1024),
    pct:     Math.round((usedMem / totalMem) * 100),
  };

  const proc = process.memoryUsage();

  res.json({
    cpu: { pct: cpuPct, cores: os.cpus().length, model: os.cpus()[0]?.model ?? "" },
    mem,
    process: {
      heapUsedMb:  Math.round(proc.heapUsed  / 1024 / 1024),
      heapTotalMb: Math.round(proc.heapTotal / 1024 / 1024),
      rssMb:       Math.round(proc.rss       / 1024 / 1024),
    },
    uptime: {
      systemSec:  Math.floor(os.uptime()),
      processSec: Math.floor(process.uptime()),
    },
    platform: os.platform(),
    hostname: os.hostname(),
  });
});

export default router;

// GET /api/system/info — dados de configuração que a interface mostra (sem segredos).
export const systemInfoRouter = Router();

systemInfoRouter.get("/", (_req, res) => {
  const sched = getSchedulerConfig();
  res.json({
    shopifyStore: getShopifyStore(),
    apiVersion: SHOPIFY_API_VERSION,
    autoSync: sched,
  });
});
