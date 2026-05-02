import express from "express";
import cors from "cors";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get("/", (req, res) => {
  res.send("Fadi's Clover backend is running.");
});

app.post("/create-checkout", async (req, res) => {
  try {
    console.log("Checkout request body:", JSON.stringify(req.body));

    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.log("Cart is empty.");
      return res.status(400).json({ error: "Cart is empty." });
    }

    const shoppingCart = {
      lineItems: items.map(item => ({
        name: String(item.name || "Menu Item"),
        price: Math.round(Number(item.price) * 100),
        unitQty: Number(item.qty) || 1,
        note: String(item.name || "")
      }))
    };

    const cloverUrl =
      process.env.CLOVER_ENV === "production"
        ? "https://scl.clover.com/invoicingcheckoutservice/v1/checkouts"
        : "https://scl-sandbox.dev.clover.com/invoicingcheckoutservice/v1/checkouts";

    console.log("Clover environment:", process.env.CLOVER_ENV);
    console.log("Clover URL:", cloverUrl);
    console.log("Token exists:", !!process.env.CLOVER_PRIVATE_TOKEN);

    const response = await fetch(cloverUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CLOVER_PRIVATE_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "Fadis-Shawarma-Checkout"
      },
      body: JSON.stringify({
        customer: {},
        shoppingCart,
        redirectUrls: {
          success: "https://fadishawarma.ca/thankyou.html",
          failure: "https://fadishawarma.ca/"
        }
      })
    });

    const rawText = await response.text();

    console.log("Clover status:", response.status);
    console.log("Clover raw response:", rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }

    if (!response.ok) {
      console.error("CLOVER ERROR:", data);
      return res.status(response.status).json({
        error: "Clover checkout failed.",
        cloverStatus: response.status,
        cloverResponse: data
      });
    }

    res.json({
      checkoutUrl: data.href || data.checkoutUrl || data.url,
      raw: data
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);
    res.status(500).json({
      error: "Checkout creation failed.",
      details: error.message
    });
  }
});

const port = process.env.PORT || 10000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
