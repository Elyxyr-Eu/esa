import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ⚠️ IMPORTANT : dans Render, mets bien
// SHOPIFY_STORE_DOMAIN = ton-shop.myshopify.com (PAS ton domaine custom)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
  console.warn(
    "[Elyxyr] ATTENTION: SHOPIFY_STORE_DOMAIN ou SHOPIFY_ADMIN_API_ACCESS_TOKEN manquant dans les variables d'environnement."
  );
}

/**
 * Helper pour appeler l'API Admin Shopify (REST)
 */
async function shopifyRequest(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    throw new Error("Shopify env vars not configured");
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("[Shopify API Error]", response.status, text);
    throw new Error(`Shopify API error: ${response.status} - ${text}`);
  }

  const data = await response.json().catch(() => ({}));
  return data;
}

/**
 * Récupère les crédits Elyxyr d'un client
 * Metafield: namespace = "custom", key = "credits_elyxyr"
 */
async function getCustomerCredits(customerId: string): Promise<number> {
  const data = await shopifyRequest(
    `/customers/${customerId}/metafields.json?namespace=custom&key=credits_elyxyr`,
    { method: "GET" }
  );

  const metafields = (data.metafields || []) as Array<{
    id: number;
    key: string;
    namespace: string;
    value: string;
  }>;

  if (metafields.length === 0) {
    return 0;
  }

  const mf = metafields[0];
  const value = parseInt(mf.value, 10);
  return isNaN(value) ? 0 : value;
}

/**
 * Met à jour les crédits Elyxyr d'un client
 */
async function setCustomerCredits(
  customerId: string,
  newBalance: number
): Promise<void> {
  const data = await shopifyRequest(
    `/customers/${customerId}/metafields.json?namespace=custom&key=credits_elyxyr`,
    { method: "GET" }
  );

  const metafields = (data.metafields || []) as Array<{
    id: number;
    key: string;
    namespace: string;
    value: string;
  }>;

  if (metafields.length > 0) {
    const mfId = metafields[0].id;

    await shopifyRequest(`/metafields/${mfId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        metafield: {
          id: mfId,
          value: newBalance.toString(),
          type: "number_integer",
        },
      }),
    });
  } else {
    await shopifyRequest(`/metafields.json`, {
      method: "POST",
      body: JSON.stringify({
        metafield: {
          namespace: "custom",
          key: "credits_elyxyr",
          value: newBalance.toString(),
          type: "number_integer",
          owner_id: Number(customerId),
          owner_resource: "customer",
        },
      }),
    });
  }
}

/**
 * Ping simple
 */
app.get("/apps/elyxyr/ping", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/**
 * GET /apps/elyxyr/credits/:customerId
 * -> lit le solde de crédits
 */
app.get(
  "/apps/elyxyr/credits/:customerId",
  async (req: Request, res: Response) => {
    try {
      const { customerId } = req.params;
      const credits = await getCustomerCredits(customerId);
      res.json({ customerId, credits });
    } catch (err: any) {
      console.error("[GET credits error]", err);
      res.status(500).json({ error: "Unable to fetch credits" });
    }
  }
);

/**
 * POST /apps/elyxyr/credits/:customerId
 * Body: { "credits": 123 }
 */
app.post(
  "/apps/elyxyr/credits/:customerId",
  async (req: Request, res: Response) => {
    try {
      const { customerId } = req.params;
      const { credits } = req.body as { credits: number };

      if (typeof credits !== "number" || isNaN(credits) || credits < 0) {
        return res
          .status(400)
          .json({ error: "Invalid 'credits' value. Must be a positive number." });
      }

      const normalized = Math.floor(credits);
      await setCustomerCredits(customerId, normalized);

      res.json({ customerId, credits: normalized });
    } catch (err: any) {
      console.error("[SET credits error]", err);
      res.status(500).json({ error: "Unable to set credits" });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Elyxyr app server running on port ${PORT}`);
  console.log(`Ping:        /apps/elyxyr/ping`);
  console.log(`GET credits: /apps/elyxyr/credits/:customerId`);
  console.log(`SET credits: POST /apps/elyxyr/credits/:customerId`);
});
