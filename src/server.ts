import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

/* -------------------------------------------------------------------------- */
/*                           🔥  CORS SHOPIFY OK                               */
/* -------------------------------------------------------------------------- */

const allowedOrigins = [
  "https://elyxyr.eu",
  "https://www.elyxyr.eu",
  "https://vexjts-dp.myshopify.com"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") return res.sendStatus(200);

  next();
});

/* -------------------------------------------------------------------------- */
/*                           ⚙️ PARAMÈTRES SHOPIFY                             */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3000;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN!;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

/* -------------------------------------------------------------------------- */
/*                       🔧 FONCTION REQUÊTE SHOPIFY                          */
/* -------------------------------------------------------------------------- */

async function shopifyRequest(path: string, options: RequestInit = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();

  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}

  if (!response.ok) {
    console.error("[Shopify API ERROR]", response.status, text);
    throw new Error(`Shopify API error: ${response.status} - ${text}`);
  }

  return data;
}

/* -------------------------------------------------------------------------- */
/*                     🔥 MÉTAFIELS CRÉDITS CLIENT                            */
/* -------------------------------------------------------------------------- */

async function getCustomerCredits(customerId: string): Promise<number> {
  const data = await shopifyRequest(
    `/customers/${customerId}/metafields.json?namespace=custom&key=credits_elyxyr`
  );

  const metafields = (data as any).metafields || [];
  if (!metafields.length) return 0;

  const val = parseInt(metafields[0].value, 10);
  return isNaN(val) ? 0 : val;
}

async function setCustomerCredits(customerId: string, newBalance: number) {
  const data = await shopifyRequest(
    `/customers/${customerId}/metafields.json?namespace=custom&key=credits_elyxyr`
  );

  const metafields = (data as any).metafields || [];

  if (metafields.length > 0) {
    const mfId = metafields[0].id;

    await shopifyRequest(`/metafields/${mfId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        metafield: {
          id: mfId,
          value: `${newBalance}`,
          type: "number_integer"
        }
      })
    });
  } else {
    await shopifyRequest(`/metafields.json`, {
      method: "POST",
      body: JSON.stringify({
        metafield: {
          namespace: "custom",
          key: "credits_elyxyr",
          value: `${newBalance}`,
          type: "number_integer",
          owner_id: Number(customerId),
          owner_resource: "customer"
        }
      })
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                     🎯 WEIGHTED RANDOM DYNAMIQUE                           */
/* -------------------------------------------------------------------------- */

function weightedRandom(items: any[]) {
  const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
  const rnd = Math.random() * totalWeight;

  let sum = 0;
  for (const item of items) {
    sum += item.weight;
    if (rnd <= sum) return item;
  }
  return items[items.length - 1];
}

/* -------------------------------------------------------------------------- */
/*                🧾 CRÉATION COMMANDE AUTOMATIQUE SHOPIFY                    */
/* -------------------------------------------------------------------------- */

async function createLootboxOrder(customerId: string, prize: any) {
  const data = await shopifyRequest(`/orders.json`, {
    method: "POST",
    body: JSON.stringify({
      order: {
        customer: { id: Number(customerId) },
        line_items: [
          {
            variant_id: prize.variantId,
            quantity: 1
          }
        ],
        financial_status: "paid",
        tags: "Elyxyr Lootbox",
        note: `Gain lootbox : ${prize.title}`
      }
    })
  });

  return (data as any)?.order?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/*                                   ROUTES                                   */
/* -------------------------------------------------------------------------- */

app.get("/apps/elyxyr/ping", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.json({ status: "ok" });
});

app.get("/apps/elyxyr/credits/:customerId", async (req, res) => {
  try {
    const credits = await getCustomerCredits(req.params.customerId);
    res.json({ customerId: req.params.customerId, credits });
  } catch {
    res.status(500).json({ error: "Unable to fetch credits" });
  }
});

/* -------------------------------------------------------------------------- */
/*                       🎁 SPIN — VERSION DYNAMIQUE                           */
/* -------------------------------------------------------------------------- */
/*

👉 Shopify envoie :
{
  customerId: "24070...",
  boxId: "elyxyr_basic",
  priceCredits: 10,
  items: [
    { variantId: 123, title:"X", weight:10 },
    { variantId: 456, title:"Y", weight:50 },
    etc...
  ]
}

*/

app.post("/apps/elyxyr/spin", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");

  try {
    const { customerId, priceCredits, items } = req.body;

    if (!customerId || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "Missing or invalid items" });
    }

    const before = await getCustomerCredits(customerId);
    if (before < priceCredits) {
      return res.status(400).json({
        error: "Not enough credits",
        current: before,
        required: priceCredits
      });
    }

    const after = before - priceCredits;
    const prize = weightedRandom(items);

    await setCustomerCredits(customerId, after);

    let orderId = null;
    let orderError = null;

    try {
      orderId = await createLootboxOrder(customerId, prize);
    } catch (err: any) {
      orderError = err.message || String(err);
    }

    res.json({
      success: true,
      customerId,
      credits_before: before,
      credits_after: after,
      price_credits: priceCredits,
      prize,
      orderId,
      orderError
    });

  } catch (e) {
    console.error("SPIN ERROR", e);
    res.status(500).json({ error: "Internal error" });
  }
});

/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`🔥 Elyxyr backend running on port ${PORT}`);
});

