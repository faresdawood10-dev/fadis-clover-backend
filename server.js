import express from "express";
import cors from "cors";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

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
  return items.map(item => ({
    name: String(item.name || "Menu Item").slice(0, 255),
    price: Math.round(Number(item.price) * 100),
    qty: Number(item.qty) || 1
  }));
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
      `Source: fadishawarma.ca`;

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
            note: `Order #${orderNumber} | Customer: ${name}`
          })
        }
      );
    }

    let printResult = null;
    let printWarning = null;

    try {
      printResult = await cloverFetch(
        `${API_BASE}/v3/merchants/${MERCHANT_ID}/print_event`,
        {
          method: "POST",
          body: JSON.stringify({
            orderRef: { id: orderId }
          })
        }
      );
    } catch (printError) {
      printWarning = {
        status: printError.status || 500,
        data: printError.data || printError.message
      };
      console.error("PRINT ERROR:", printWarning);
    }

    const shoppingCart = {
      lineItems: cleanItems.map(item => ({
        name: item.name,
        price: item.price,
        unitQty: item.qty
      }))
    };

    const checkout = await cloverFetch(CHECKOUT_URL, {
      method: "POST",
      body: JSON.stringify({
        customer: {
          firstName: name
        },
        shoppingCart,
        redirectUrls: {
          success: "https://fadishawarma.ca/thankyou.html",
          failure: "https://fadishawarma.ca/"
        }
      })
    });

    const checkoutUrl = checkout.href || checkout.checkoutUrl || checkout.url;

    if (!checkoutUrl) {
      return res.status(500).json({
        error: "Clover checkout created, but no checkout URL was returned.",
        checkout,
        orderId,
        printResult,
        printWarning
      });
    }

    res.json({
      checkoutUrl,
      orderId,
      orderNumber,
      printResult,
      printWarning,
      raw: checkout
    });

  } catch (error) {
    console.error("SERVER/CLOVER ERROR:", {
      message: error.message,
      status: error.status,
      data: error.data
    });

    res.status(error.status || 500).json({
      error: "Checkout/order/print failed.",
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
