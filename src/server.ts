import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

/* -------------------------------------------------------------------------- */
/*                              🔥 CORS 100% OK                               */
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

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});


/* -------------------------------------------------------------------------- */
/*                            ⚙️ CONFIG SHOPIFY                                */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3000;

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN as string;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN as string;
const SHOPIFY_API_VERSION = (process.env.SHOPIFY_API_VERSION || "2024-10") as string;


if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
  console.warn("[Elyxyr] ⚠️ SHOPIFY_STORE_DOMAIN ou SHOPIFY_ADMIN_API_ACCESS_TOKEN manquant.");
}


/* -------------------------------------------------------------------------- */
/*                             🔧 Shopify Request                              */
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

  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    console.error("[Shopify API Error]", response.status, text);
    throw new Error(`Shopify API error: ${response.status} - ${text}`);
  }

  return data;
}


/* -------------------------------------------------------------------------- */
/*                         🔥 METAFIELDS CRÉDITS CLIENT                       */
/* -------------------------------------------------------------------------- */

async function getCustomerCredits(customerId: string): Promise<number> {
  const data = await shopifyRequest(
    `/customers/${customerId}/metafields.json?namespace=custom&key=credits_elyxyr`,
    { method: "GET" }
  );

  const metafields = (data.metafields || []) as Array<{ value: string }>;
  if (!metafields.length) return 0;

  const val = parseInt(metafields[0].value, 10);
  return isNaN(val) ? 0 : val;
}

async function setCustomerCredits(customerId: string, newBalance: number): Promise<void> {
  const data = await shopifyRequest(
    `/customers/${customerId}/metafields.json?namespace=custom&key=credits_elyxyr`,
    { method: "GET" }
  );

  const metafields = (data.metafields || []) as Array<{ id: number }>;

  if (metafields.length > 0) {
    const mfId = metafields[0].id;

    await shopifyRequest(`/metafields/${mfId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        metafield: {
          id: mfId,
          value: String(newBalance),
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
          value: String(newBalance),
          type: "number_integer",
          owner_id: Number(customerId),
          owner_resource: "customer"
        }
      })
    });
  }
}


/* -------------------------------------------------------------------------- */
/*                                🎁 LOOTBOXES                                */
/* -------------------------------------------------------------------------- */

type LootItem = {
  variantId: number;
  title: string;
  weight: number;
};

type LootBox = {
  id: string;
  name: string;
  priceCredits: number;
  items: LootItem[];
};

// 🔥 TON PRODUIT TEST
const LOOTBOXES: LootBox[] = [
  {
    id: "elyxyr_basic",
    name: "Lootbox Elyxyr Basic",
    priceCredits: 10,
    items: [
      {
        variantId: 56903978746240,
        title: "Produit Test Unique",
        weight: 100
      }
    ]
  }
];

function getLootbox(boxId: string) {
  return LOOTBOXES.find(b => b.id === boxId);
}

function weightedRandom(items: LootItem[]): LootItem {
  const total = items.reduce((s, i) => s + i.weight, 0);
  const rnd = Math.random() * total;
  let sum = 0;

  for (const item of items) {
    sum += item.weight;
    if (rnd <= sum) return item;
  }
  return items[items.length - 1];
}


/* -------------------------------------------------------------------------- */
/*                        🧾 Création commande Shopify                        */
/* -------------------------------------------------------------------------- */

async function createLootboxOrder(customerId: string, prize: LootItem, box: LootBox) {
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
        note: `Gain lootbox ${box.name}`
      }
    })
  });

  return data?.order?.id ?? null;
}


/* -------------------------------------------------------------------------- */
/*                                   ROUTES                                   */
/* -------------------------------------------------------------------------- */

// Test API
app.get("/apps/elyxyr/ping", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", _req.headers.origin || "*");
  res.json({ status: "ok" });
});

// Credits GET
app.get("/apps/elyxyr/credits/:customerId", async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");

    const credits = await getCustomerCredits(req.params.customerId);
    res.json({ customerId: req.params.customerId, credits });
  } catch (e) {
    res.status(500).json({ error: "Unable to fetch credits" });
  }
});

// Credits SET
app.post("/apps/elyxyr/credits/:customerId", async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");

    const credits = Number(req.body.credits);
    if (isNaN(credits)) return res.status(400).json({ error: "Invalid credits" });

    await setCustomerCredits(req.params.customerId, Math.floor(credits));

    res.json({ customerId: req.params.customerId, credits: Math.floor(credits) });
  } catch (e) {
    res.status(500).json({ error: "Unable to set credits" });
  }
});

// Spin
app.post("/apps/elyxyr/spin", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");

  try {
    const { customerId, boxId } = req.body;

    if (!customerId || !boxId) {
      return res.status(400).json({ error: "Missing customerId or boxId" });
    }

    const box = getLootbox(boxId);
    if (!box) return res.status(400).json({ error: "Unknown lootbox" });

    const beforeCredits = await getCustomerCredits(customerId);
    if (beforeCredits < box.priceCredits) {
      return res.status(400).json({
        error: "Not enough credits",
        current: beforeCredits,
        required: box.priceCredits
      });
    }

    const afterCredits = beforeCredits - box.priceCredits;

    const prize = weightedRandom(box.items);
    await setCustomerCredits(customerId, afterCredits);

    let orderId: number | null = null;
    let orderError: string | null = null;

    try {
      orderId = await createLootboxOrder(customerId, prize, box);
    } catch (err: any) {
      orderError = err.message || String(err);
    }

    res.json({
      success: true,
      customerId,
      boxId,
      boxName: box.name,
      credits_before: beforeCredits,
      credits_after: afterCredits,
      price_credits: box.priceCredits,
      prize: {
        variantId: prize.variantId,
        title: prize.title
      },
      orderId,
      orderError
    });
  } catch (e) {
    console.error("SPIN ERROR", e);
    res.status(500).json({ error: "Internal error on spin" });
  }
});


/* -------------------------------------------------------------------------- */
/*                             UI DE TEST VISUEL                               */
/* -------------------------------------------------------------------------- */

app.get("/apps/elyxyr/test-spin", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", _req.headers.origin || "*");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<html><body>
<h1>Test Spin</h1>
<form>
<input id="cid" value="24070351749504" />
<button type="button" onclick="spin()">Spin</button>
</form>
<pre id="out"></pre>
<script>
function spin() {
  fetch('/apps/elyxyr/spin', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ customerId:document.getElementById('cid').value, boxId:'elyxyr_basic' })
  })
  .then(r=>r.json())
  .then(j=> document.getElementById('out').textContent = JSON.stringify(j,null,2))
  .catch(e=> document.getElementById('out').textContent = e);
}
</script>
</body></html>
`);
});


/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`🔥 Elyxyr backend running on port ${PORT}`);
});

