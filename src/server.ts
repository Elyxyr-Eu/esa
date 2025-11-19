import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// IMPORTANT : SHOPIFY_STORE_DOMAIN doit être le domaine myshopify.com, ex : elyxyr-eu.myshopify.com
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
  variantId: number; // ID de la variante Shopify (integer)
  title: string; // titre lisible (pour le JSON retour)
  weight: number; // poids de probabilité (plus c'est grand, plus c'est fréquent)
};

type LootBox = {
  id: string; // identifiant interne, ex: "basic"
  name: string;
  priceCredits: number;
  items: LootItem[];
};

// ⚠️ À ADAPTER AVEC TES VRAIS VARIANTS PRODUITS
// Tu peux commencer avec des faux IDs pour tester la logique.
const LOOTBOXES: LootBox[] = [
  {
    id: "elyxyr_basic",
    name: "Lootbox Elyxyr Basic",
    priceCredits: 10,
    items: [
      {
        variantId: 1234567890, // met ici un vrai variant_id Shopify
        title: "Booster Pokémon - Commun",
        weight: 60,
      },
      {
        variantId: 1234567891,
        title: "Booster Pokémon - Rare",
        weight: 30,
      },
      {
        variantId: 1234567892,
        title: "Display Pokémon - Jackpot",
        weight: 10,
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
    try {
      const order = await createLootboxOrder(customerId, prize, box);
      orderId = order.orderId;
    } catch (orderErr) {
      console.error("[Lootbox] Erreur création commande", orderErr);
      // On ne remonte pas l'erreur au client pour ne pas casser l'expérience,
      // mais en prod tu peux décider de rollback les crédits si nécessaire.
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
    });
  } catch (err: any) {
    console.error("[/apps/elyxyr/spin error]", err);
    res.status(500).json({ error: "Internal error on spin" });
  }
});

/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`Elyxyr app server running on port ${PORT}`);
  console.log(`Ping:        /apps/elyxyr/ping`);
  console.log(`GET credits: /apps/elyxyr/credits/:customerId`);
  console.log(`SET credits: POST /apps/elyxyr/credits/:customerId`);
  console.log(`Spin:        POST /apps/elyxyr/spin`);
});
