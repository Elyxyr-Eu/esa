import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * Route de test Elyxyr
 * URL: GET /apps/elyxyr/ping
 */
app.get("/apps/elyxyr/ping", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Elyxyr app server running on port ${PORT}`);
  console.log(`Test route: http://localhost:${PORT}/apps/elyxyr/ping`);
});
