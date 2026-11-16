import basicAuth from "basic-auth";
import { Request, Response, NextFunction } from "express";

export function apiAuth(req: Request, res: Response, next: NextFunction) {
  // BASIC
  const creds = basicAuth(req);
  const okBasic =
    !!creds &&
    creds.name === process.env.API_USER &&
    creds.pass === process.env.API_PASSWORD;

  if (!okBasic) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MEGADIGITAL"');
    return res.status(401).json({ error: "Unauthorized (basic)" });
  }

  // TOKEN
  const token = (req.header("x-api-key") || req.query.token) as string | undefined;
  if (!token || token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized (token)" });
  }

  return next();
}
