import express from "express";
import cors from "cors";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

const ENV = process.env.CLOVER_ENV || "production";
const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
const TOKEN = process.env.CLOVER_PRIVATE_TOKEN;

const API_BASE =
  ENV === "production"
    ? "https://api.clover.com"
    : "https://apisandbox.dev.clover.com";

const CHECKOUT_URL =
  ENV === "production"
    ? "https://api.clover.com/invoicingcheckoutservice/v1/checkouts"
    : "https://apisandbox.dev.clover.com/invoicingcheckoutservice/v1/checkouts";

/*
  Temporary memory storage:
  This connects the Clover checkout session to the Clover order we created.
  It prevents printing before payment.

  Important:
  If Render restarts before the customer pays, this memory is cleared.
  For a perfect production setup later, use a database.
*/
const pendingOrders = new Map();
const printedOrders = new Set();

const HST_TAX_RATE = {
  name: "Tax",
  rate: 1300000
};

function cloverHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "X-Clover-Merchant-Id": MERCHANT_ID,
    "Content-Type": "application/json",
    "User-Agent": "Fadis-Shawarma-Checkout"
  };
}

async function cloverFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...cloverHeaders(),
      ...(options.headers || {})
    }
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  console.log("Clover URL:", url);
  console.log("Clover status:", response.status);
  console.log("Clover raw response:", rawText);

  if (!response.ok) {
    const error = new Error("Clover request failed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function sanitizeItems(items) {
  return items
    .map(item => {
      const name = String(item.name || "Menu Item").slice(0, 255);
      const priceDollars = Number(item.price) || 0;
      const priceCents = Math.round(priceDollars * 100);
      const qty = Number(item.qty) || 1;

      return {
        name,
        price: priceCents,
        qty,
        note: String(item.note || item.optionsText || "").slice(0, 500)
      };
    })
    .filter(item => item.price >= 0 && item.qty > 0);
}

function isTipOrTaxLine(itemName) {
  const name = String(itemName || "").toLowerCase();
  return (
    name.includes("tip") ||
    name.includes("hst") ||
    name.includes("tax")
  );
}

function shouldApplyTax(item) {
  return item.price > 0 && !isTipOrTaxLine(item.name);
}

function buildCheckoutLineItem(item) {
  const line = {
    name: item.name,
    price: item.price,
    unitQty: item.qty
  };

  if (shouldApplyTax(item)) {
    line.taxRates = [HST_TAX_RATE];
  }

  return line;
}

function findValueDeep(obj, keysToFind) {
  if (!obj || typeof obj !== "object") return null;

  for (const key of Object.keys(obj)) {
    if (keysToFind.includes(key)) {
      return obj[key];
    }

    const value = obj[key];

    if (value && typeof value === "object") {
      const found = findValueDeep(value, keysToFind);
      if (found) return found;
    }
  }

  return null;
}

function extractCheckoutId(payload) {
  /*
    Clover Hosted Checkout webhook commonly sends the checkout session id
    inside data or Data. This function is flexible so we can catch different
    Clover payload shapes.
  */
  const direct =
    payload?.data ||
    payload?.Data ||
    payload?.checkoutId ||
    payload?.checkout_id ||
    payload?.checkoutSessionId ||
    payload?.checkoutSessionID ||
    payload?.checkout?.id ||
    payload?.session?.id;

  if (typeof direct === "string") return direct;

  const deep = findValueDeep(payload, [
    "checkoutId",
    "checkout_id",
    "checkoutSessionId",
    "checkoutSessionID"
  ]);

  if (typeof deep === "string") return deep;

  return null;
}

function webhookLooksPaid(payload) {
  const text = JSON.stringify(payload || {}).toLowerCase();

  const approvedWords = [
    "approved",
    "paid",
    "success",
    "succeeded",
    "completed",
    "complete"
  ];

  const declinedWords = [
    "declined",
    "failed",
    "failure",
    "cancelled",
    "canceled",
    "voided",
    "refund",
    "refunded"
  ];

  const hasApprovedWord = approvedWords.some(word => text.includes(word));
  const hasDeclinedWord = declinedWords.some(word => text.includes(word));

  return hasApprovedWord && !hasDeclinedWord;
}

async function printOrder(orderId) {
  if (!orderId) {
    throw new Error("Missing Clover orderId for printing.");
  }

  if (printedOrders.has(orderId)) {
    return {
      skipped: true,
      reason: "Order already printed.",
      orderId
    };
  }

  const printResult = await cloverFetch(
    `${API_BASE}/v3/merchants/${MERCHANT_ID}/print_event`,
    {
      method: "POST",
      body: JSON.stringify({
        orderRef: { id: orderId }
      })
    }
  );

  printedOrders.add(orderId);

  return {
    skipped: false,
    orderId,
    printResult
  };
}

app.get("/", (req, res) => {
  res.send("Fadi's Clover backend is running.");
});

app.post("/create-checkout", async (req, res) => {
  try {
    console.log("Checkout request body:", JSON.stringify(req.body));

    if (!MERCHANT_ID || !TOKEN) {
      return res.status(500).json({
        error: "Missing Clover environment variables."
      });
    }

    const { items, customerName } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty." });
    }

    const cleanItems = sanitizeItems(items);
    const name = customerName ? String(customerName).trim().slice(0, 80) : "Guest";
    const orderNumber = Date.now().toString().slice(-5);

    const orderNote =
      `ONLINE ORDER #${orderNumber}\n` +
      `Customer: ${name}\n` +
      `Source: fadishawarma.ca\n` +
      `Status: Pending payment - do not prepare until paid`;

    /*
      Create the Clover order now, but DO NOT PRINT it here.
      It will only print after Clover sends the paid webhook.
    */
    const order = await cloverFetch(
      `${API_BASE}/v3/merchants/${MERCHANT_ID}/orders`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `Online Order #${orderNumber}`,
          note: orderNote
        })
      }
    );

    const orderId = order.id;

    for (const item of cleanItems) {
      await cloverFetch(
        `${API_BASE}/v3/merchants/${MERCHANT_ID}/orders/${orderId}/line_items`,
        {
          method: "POST",
          body: JSON.stringify({
            name: item.name,
            price: item.price,
            unitQty: item.qty,
            note:
              item.note ||
              `Order #${orderNumber} | Customer: ${name} | Pending payment`
          })
        }
      );
    }

    const shoppingCart = {
      lineItems: cleanItems.map(buildCheckoutLineItem)
    };

    const checkout = await cloverFetch(CHECKOUT_URL, {
      method: "POST",
      body: JSON.stringify({
        customer: {
          firstName: name
        },
        shoppingCart,
        tips: {
          enabled: true
        },
        redirectUrls: {
          success: "https://fadishawarma.ca/thankyou.html",
          failure: "https://fadishawarma.ca/"
        }
      })
    });

    const checkoutUrl = checkout.href || checkout.checkoutUrl || checkout.url;
    const checkoutId =
      checkout.id ||
      checkout.checkoutId ||
      checkout.checkout_id ||
      checkout.uuid ||
      extractCheckoutId(checkout);

    if (!checkoutUrl) {
      return res.status(500).json({
        error: "Clover checkout created, but no checkout URL was returned.",
        checkout,
        orderId
      });
    }

    if (checkoutId) {
      pendingOrders.set(String(checkoutId), {
        orderId,
        orderNumber,
        customerName: name,
        checkoutId: String(checkoutId),
        createdAt: new Date().toISOString()
      });

      console.log("Pending paid-print saved:", {
        checkoutId,
        orderId,
        orderNumber
      });
    } else {
      console.warn(
        "WARNING: No checkoutId found in Clover checkout response. Webhook may not be able to find the order to print."
      );
    }

    res.json({
      checkoutUrl,
      checkoutId: checkoutId || null,
      orderId,
      orderNumber,
      message: "Checkout created. Order will print only after Clover payment webhook is approved.",
      raw: checkout
    });

  } catch (error) {
    console.error("SERVER/CLOVER ERROR:", {
      message: error.message,
      status: error.status,
      data: error.data
    });

    res.status(error.status || 500).json({
      error: "Checkout/order failed.",
      details: error.message,
      cloverStatus: error.status,
      cloverResponse: error.data
    });
  }
});

/*
  Clover Hosted Checkout webhook:
  Set your Clover Hosted Checkout webhook URL to:

  https://fadis-clover-backend.onrender.com/clover-webhook

  This route prints the order ONLY after Clover sends an approved/paid webhook.
*/
app.post("/clover-webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("Clover webhook payload:", JSON.stringify(payload));

    const checkoutId = extractCheckoutId(payload);
    const looksPaid = webhookLooksPaid(payload);

    if (!looksPaid) {
      return res.status(200).json({
        received: true,
        printed: false,
        reason: "Webhook was not approved/paid.",
        checkoutId
      });
    }

    if (!checkoutId) {
      return res.status(200).json({
        received: true,
        printed: false,
        reason: "Paid webhook received, but checkoutId was not found in payload.",
        payload
      });
    }

    const pending = pendingOrders.get(String(checkoutId));

    if (!pending) {
      return res.status(200).json({
        received: true,
        printed: false,
        reason: "Paid webhook received, but no pending order was found for this checkoutId. The server may have restarted.",
        checkoutId
      });
    }

    const result = await printOrder(pending.orderId);

    pendingOrders.delete(String(checkoutId));

    return res.status(200).json({
      received: true,
      paid: true,
      printed: !result.skipped,
      checkoutId,
      orderId: pending.orderId,
      orderNumber: pending.orderNumber,
      result
    });

  } catch (error) {
    console.error("WEBHOOK/PRINT ERROR:", {
      message: error.message,
      status: error.status,
      data: error.data
    });

    return res.status(error.status || 500).json({
      error: "Webhook received, but printing failed.",
      details: error.message,
      cloverStatus: error.status,
      cloverResponse: error.data
    });
  }
});

/*
  Optional emergency manual print:
  Use only if the customer paid but the webhook did not print.

  POST:
  https://fadis-clover-backend.onrender.com/manual-print/ORDER_ID
*/
app.post("/manual-print/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const result = await printOrder(orderId);

    res.json({
      success: true,
      orderId,
      result
    });
  } catch (error) {
    console.error("MANUAL PRINT ERROR:", {
      message: error.message,
      status: error.status,
      data: error.data
    });

    res.status(error.status || 500).json({
      error: "Manual print failed.",
      details: error.message,
      cloverStatus: error.status,
      cloverResponse: error.data
    });
  }
});

const port = process.env.PORT || 10000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
