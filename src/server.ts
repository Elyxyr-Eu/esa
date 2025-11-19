import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// IMPORTANT : SHOPIFY_STORE_DOMAIN doit être le domaine myshopify.com, ex : ton-boutique.myshopify.com
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
  console.warn(
    "[Elyxyr] ATTENTION: SHOPIFY_STORE_DOMAIN ou SHOPIFY_ADMIN_API_ACCESS_TOKEN manquant dans les variables d'environnement."
  );
}

/* -------------------------------------------------------------------------- */
/*                               Shopify helper                               */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*                         Crédits client (metafield)                         */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*                               Lootbox config                               */
/* -------------------------------------------------------------------------- */

type LootItem = {
  variantId: number; // ID de la variante Shopify (PAS l'ID produit)
  title: string; // titre lisible (pour le JSON retour)
  weight: number; // poids de probabilité
};

type LootBox = {
  id: string;
  name: string;
  priceCredits: number;
  items: LootItem[];
};

// ⚠️ ICI tu dois mettre TON vrai variant_id (l'ID après /variants/...)
// Pour l'instant on laisse 15439534293376 pour tester les erreurs, mais c'est un product_id.
const LOOTBOXES: LootBox[] = [
  {
    id: "elyxyr_basic",
    name: "Lootbox Elyxyr Basic",
    priceCredits: 10,
    items: [
      {
        variantId: 56903978746240, // ✅ vrai variant_id du "produit test"
        title: "Produit Test Unique",
        weight: 100,
      },
    ],
  },
];


function getLootbox(boxId: string): LootBox | undefined {
  return LOOTBOXES.find((b) => b.id === boxId);
}

function weightedRandom(items: LootItem[]): LootItem {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const rnd = Math.random() * totalWeight;
  let cum = 0;
  for (const item of items) {
    cum += item.weight;
    if (rnd <= cum) return item;
  }
  return items[items.length - 1];
}

/* -------------------------------------------------------------------------- */
/*                        Création de commande Shopify                        */
/* -------------------------------------------------------------------------- */

async function createLootboxOrder(
  customerId: string,
  prize: LootItem,
  box: LootBox
): Promise<{ orderId: number }> {
  const body = {
    order: {
      customer: {
        id: Number(customerId),
      },
      line_items: [
        {
          variant_id: prize.variantId,
          quantity: 1,
        },
      ],
      financial_status: "paid",
      tags: "Elyxyr Lootbox",
      note: `Gain lootbox ${box.name}`,
    },
  };

  const data = await shopifyRequest(`/orders.json`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return { orderId: data.order.id as number };
}

/* -------------------------------------------------------------------------- */
/*                                   Routes                                   */
/* -------------------------------------------------------------------------- */

// Ping simple
app.get("/apps/elyxyr/ping", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// GET crédits
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

// SET crédits (admin / tests)
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

// LOTERIE / LOOTBOX
// POST /apps/elyxyr/spin
// Body: { "customerId": "1234567890", "boxId": "elyxyr_basic" }
app.post("/apps/elyxyr/spin", async (req: Request, res: Response) => {
  try {
    const { customerId, boxId } = req.body as {
      customerId?: string;
      boxId?: string;
    };

    if (!customerId || !boxId) {
      return res
        .status(400)
        .json({ error: "Missing 'customerId' or 'boxId' in body." });
    }

    const box = getLootbox(boxId);
    if (!box) {
      return res.status(400).json({ error: `Unknown lootbox '${boxId}'` });
    }

    // 1) Vérifier crédits
    const beforeCredits = await getCustomerCredits(customerId);

    if (beforeCredits < box.priceCredits) {
      return res.status(400).json({
        error: "Not enough credits",
        required: box.priceCredits,
        current: beforeCredits,
      });
    }

    // 2) Tirage au sort
    const prize = weightedRandom(box.items);

    // 3) Débiter les crédits
    const afterCredits = beforeCredits - box.priceCredits;
    await setCustomerCredits(customerId, afterCredits);

    // 4) Créer la commande Shopify pour le gain
    let orderId: number | null = null;
    let orderError: string | null = null;

    try {
      const order = await createLootboxOrder(customerId, prize, box);
      orderId = order.orderId;
    } catch (orderErr: any) {
      console.error("[Lootbox] Erreur création commande", orderErr);
      if (orderErr instanceof Error) {
        orderError = orderErr.message;
      } else {
        orderError = String(orderErr);
      }
    }

    // 5) Réponse JSON
    return res.json({
      success: true,
      customerId,
      boxId: box.id,
      boxName: box.name,
      credits_before: beforeCredits,
      credits_after: afterCredits,
      price_credits: box.priceCredits,
      prize: {
        variantId: prize.variantId,
        title: prize.title,
      },
      orderId,
      orderError,
    });
  } catch (err: any) {
    console.error("[/apps/elyxyr/spin error]", err);
    res.status(500).json({ error: "Internal error on spin" });
  }
});


/* -------------------------------------------------------------------------- */
/*                       ROUTE DEBUG POUR VOIR UN PRODUIT                     */
/* -------------------------------------------------------------------------- */

app.get(
  "/apps/elyxyr/debug-product/:productId",
  async (req: Request, res: Response) => {
    try {
      const { productId } = req.params;
      const data = await shopifyRequest(`/products/${productId}.json`, {
        method: "GET",
      });
      res.json(data);
    } catch (err: any) {
      console.error("[DEBUG PRODUCT ERROR]", err);
      res.status(500).json({ error: "Unable to fetch product", details: String(err) });
    }
  }
);

/* -------------------------------------------------------------------------- */
/*                      PAGE DE TEST VISUELLE POUR SPIN                       */
/* -------------------------------------------------------------------------- */

app.get("/apps/elyxyr/test-spin", (_req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Test Loterie Elyxyr</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background:#050816; color:#f9fafb; padding:24px;">
  <h1 style="margin-bottom:16px;">Test Loterie Elyxyr</h1>
  <p style="opacity:0.8; margin-bottom:20px;">Formulaire de test pour la route <code>/apps/elyxyr/spin</code>.</p>

  <div style="max-width:480px; padding:16px; border-radius:12px; border:1px solid #4b5563; background:#020617; margin-bottom:20px;">
    <label style="display:block; font-size:14px; margin-bottom:4px;">ID Client Shopify</label>
    <input id="customerId" type="text" value="24070351749504" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #4b5563; background:#020617; color:#f9fafb; margin-bottom:12px;" />

    <label style="display:block; font-size:14px; margin-bottom:4px;">ID de la lootbox</label>
    <input id="boxId" type="text" value="elyxyr_basic" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #4b5563; background:#020617; color:#f9fafb; margin-bottom:16px;" />

    <button id="spinBtn" style="width:100%; padding:10px 14px; border:none; border-radius:999px; background:#7c3aed; color:white; font-weight:600; cursor:pointer;">
      Lancer la box
    </button>
  </div>

  <pre id="result" style="white-space:pre-wrap; background:#020617; border-radius:12px; padding:16px; border:1px solid #4b5563;"></pre>

  <script>
    const btn = document.getElementById('spinBtn');
    const result = document.getElementById('result');

    btn.addEventListener('click', async () => {
      const customerInput = document.getElementById('customerId');
      const boxInput = document.getElementById('boxId');

      if (!customerInput || !boxInput) {
        result.textContent = 'Inputs introuvables ?';
        return;
      }

      const customerId = customerInput.value.trim();
      const boxId = boxInput.value.trim();

      if (!customerId || !boxId) {
        result.textContent = 'Veuillez renseigner customerId et boxId.';
        return;
      }

      result.textContent = 'Lancement...';

      try {
        const resp = await fetch('/apps/elyxyr/spin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId, boxId })
        });

        const data = await resp.json();
        result.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        // @ts-ignore
        result.textContent = 'Erreur: ' + (e && e.message ? e.message : e);
      }
    });
  </script>
</body>
</html>
`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`Elyxyr app server running on port ${PORT}`);
  console.log(`Ping:        /apps/elyxyr/ping`);
  console.log(`GET credits: /apps/elyxyr/credits/:customerId`);
  console.log(`SET credits: POST /apps/elyxyr/credits/:customerId`);
  console.log(`Spin:        POST /apps/elyxyr/spin`);
  console.log(`Test Spin:   GET  /apps/elyxyr/test-spin`);
});

