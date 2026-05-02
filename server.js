import express from "express";
import cors from "cors";

const app = express();

app.use(cors({
  origin: ["https://fadishawarma.ca", "https://www.fadishawarma.ca"]
}));

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Fadi's Clover backend is running.");
});

app.post("/create-checkout", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty." });
    }

    const shoppingCart = {
      lineItems: items.map(item => ({
        name: item.name,
        price: Math.round(item.price * 100),
        unitQty: item.qty || 1
      }))
    };

    const cloverUrl =
      process.env.CLOVER_ENV === "production"
        ? "https://scl.clover.com/invoicingcheckoutservice/v1/checkouts"
        : "https://scl-sandbox.dev.clover.com/invoicingcheckoutservice/v1/checkouts";

    const response = await fetch(cloverUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CLOVER_PRIVATE_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "Fadis-Shawarma-Checkout"
      },
      body: JSON.stringify({
        shoppingCart,
        redirectUrls: {
          success: "https://fadishawarma.ca/thankyou.html",
          failure: "https://fadishawarma.ca/"
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json({
      checkoutUrl: data.href || data.checkoutUrl || data.url,
      raw: data
    });

  } catch (error) {
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
