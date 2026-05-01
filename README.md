# CS2 Deal Scanner

A local CS2 skin deal scanner using the CSFloat API.
Runs on your own machine with a fixed IP — no more rate limit blocks.

## Setup

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Install dependencies
```
npm install
```

### 3. Add your API key
Create a `.env` file in this folder:
```
CSFLOAT_API_KEY=your_api_key_here
```
Get your key from: https://csfloat.com → Profile → Developer tab

### 4. Start the scanner
```
npm run dev
```

### 5. Open in browser
Go to: http://localhost:3000

---

## How it works

- Fetches broad market listings from CSFloat
- Groups by item name
- For each unique item, fetches the full price ladder
- Detects gaps between cheapest listing and next comparable listings
- Calculates fee-adjusted net profit
- Scores each deal 0-100 based on gap size, liquidity, profit, risk
- Shows trap warnings for pattern-based skins, tight ladders, low liquidity
- BUY / REVIEW / SKIP buttons log your decisions to the History tab

## Settings

| Setting | Default | Description |
|---|---|---|
| Min net profit | $20 | Minimum profit after fees |
| Min price gap | 8% | Minimum gap to next listing |
| Min item value | $50 | Ignore cheap items |
| Max item value | $2000 | Ignore very expensive items |
| Selling fee | 2% | CSFloat's selling fee |
| Min deal score | 60 | Hide weak signals |
| Ladder depth | 8 | How many listings to fetch per item |
| Scan interval | 120s | Time between scans |

## File structure

```
cs2-scanner/
  server.js        — Node.js proxy server
  package.json     — dependencies
  .env             — your API key (never share this)
  .env.example     — template
  public/
    index.html     — scanner UI
  README.md
```
