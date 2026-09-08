import { Router } from "express";

const router = Router();

const PLAY_URL = "https://play.google.com/store/apps/details?id=com.gini.myhealthgenie";
const APPSTORE_URL = "https://apps.apple.com/in/app/id6787960972";

const QR_SVG = `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h37v37H0z"/><path stroke="#000000" d="M2 2.5h7m1 0h1m1 0h1m1 0h1m1 0h1m3 0h2m3 0h2m1 0h7M2 3.5h1m5 0h1m1 0h4m1 0h1m1 0h5m2 0h1m1 0h1m1 0h1m5 0h1M2 4.5h1m1 0h3m1 0h1m1 0h1m1 0h1m1 0h3m2 0h2m1 0h2m1 0h2m1 0h1m1 0h3m1 0h1M2 5.5h1m1 0h3m1 0h1m3 0h1m1 0h1m3 0h4m2 0h2m2 0h1m1 0h3m1 0h1M2 6.5h1m1 0h3m1 0h1m2 0h1m3 0h1m1 0h4m1 0h2m1 0h1m2 0h1m1 0h3m1 0h1M2 7.5h1m5 0h1m1 0h2m1 0h1m3 0h4m2 0h2m1 0h1m1 0h1m5 0h1M2 8.5h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7M10 9.5h2m4 0h1m4 0h3m2 0h1M4 10.5h3m1 0h1m1 0h4m1 0h6m1 0h1m1 0h1m2 0h3m2 0h3M3 11.5h1m1 0h2m2 0h4m4 0h3m1 0h1m1 0h1m1 0h1m1 0h2m2 0h1m2 0h1M3 12.5h3m2 0h1m5 0h1m1 0h1m1 0h1m4 0h1m2 0h1m1 0h2m3 0h1M6 13.5h2m1 0h1m1 0h2m3 0h5m1 0h2m3 0h1m3 0h4M2 14.5h1m1 0h2m1 0h2m1 0h2m3 0h1m2 0h2m3 0h1m1 0h3m1 0h2M3 15.5h1m1 0h2m4 0h2m3 0h3m1 0h3m2 0h2m1 0h2m2 0h1m1 0h1M2 16.5h1m5 0h2m1 0h1m1 0h4m1 0h1m1 0h1m1 0h1m1 0h1m2 0h1m3 0h1m1 0h1M3 17.5h1m2 0h2m1 0h1m1 0h2m1 0h1m1 0h1m1 0h3m1 0h3m2 0h1m2 0h4M2 18.5h7m1 0h1m1 0h1m2 0h2m1 0h1m1 0h1m6 0h1m1 0h2M5 19.5h1m3 0h1m5 0h2m1 0h1m1 0h2m1 0h1m1 0h2m1 0h1m5 0h1M3 20.5h1m1 0h1m1 0h3m4 0h1m2 0h1m2 0h1m1 0h1m1 0h1m2 0h3m2 0h2M2 21.5h2m1 0h3m1 0h1m4 0h1m6 0h12m1 0h1M3 22.5h4m1 0h6m1 0h3m2 0h3m1 0h1m2 0h1m1 0h3m1 0h2M2 23.5h4m1 0h1m3 0h1m2 0h2m1 0h2m3 0h1m2 0h1m2 0h1m3 0h1m1 0h1M2 24.5h1m1 0h1m2 0h4m2 0h1m1 0h1m1 0h3m1 0h1m1 0h1m5 0h3m1 0h1M2 25.5h1m3 0h1m2 0h3m1 0h3m4 0h2m1 0h1m2 0h1m2 0h1m1 0h3M2 26.5h1m2 0h1m2 0h4m1 0h2m1 0h1m2 0h2m1 0h1m3 0h6m2 0h1M10 27.5h2m2 0h1m1 0h1m2 0h1m2 0h1m3 0h1m3 0h1m2 0h2M2 28.5h7m6 0h1m3 0h2m3 0h3m1 0h1m1 0h4M2 29.5h1m5 0h1m2 0h2m1 0h1m1 0h2m1 0h2m4 0h2m3 0h5M2 30.5h1m1 0h3m1 0h1m1 0h4m1 0h3m2 0h2m1 0h2m1 0h5m2 0h2M2 31.5h1m1 0h3m1 0h1m1 0h2m4 0h1m1 0h1m2 0h3m1 0h3m2 0h2m2 0h1M2 32.5h1m1 0h3m1 0h1m1 0h3m3 0h2m2 0h1m1 0h3m1 0h3m2 0h1M2 33.5h1m5 0h1m2 0h2m1 0h3m2 0h2m8 0h1m1 0h2M2 34.5h7m2 0h1m1 0h1m2 0h1m2 0h1m2 0h1m2 0h2m1 0h1m4 0h1"/></svg>`;

router.get("/app", (req, res) => {
  const ua = req.get("user-agent") || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  const isAndroid = /Android/.test(ua);

  res.set("Cache-Control", "no-store");

  if (isAndroid) return res.redirect(302, PLAY_URL);
  if (isIOS) return res.redirect(302, APPSTORE_URL);

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get My Gini</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#faf9ff; color:#1f2937; display:flex; min-height:100vh;
         align-items:center; justify-content:center; }
  .card { text-align:center; padding:40px 32px; max-width:360px; }
  h1 { font-size:24px; margin:0 0 8px; }
  p { color:#6b7280; margin:0 0 24px; font-size:15px; }
  .qr { width:220px; height:220px; display:block; margin:0 auto 24px;
        padding:12px; background:#fff; border-radius:12px;
        box-shadow:0 1px 3px rgba(0,0,0,.12); }
  .alt { font-size:13px; margin:0 0 12px; }
  a { display:block; padding:14px 20px; margin:10px 0; border-radius:12px;
      text-decoration:none; font-weight:600; background:#0d9488; color:#fff; }
  a.secondary { background:#fff; color:#0d9488; border:1px solid #0d9488; }
</style>
</head>
<body>
  <div class="card">
    <h1>Download My Gini</h1>
    <p>Scan this code with your phone camera. It opens the right store automatically.</p>
    ${QR_SVG}
    <p class="alt">Already on your phone? Pick your store:</p>
    <a href="${PLAY_URL}">Google Play (Android)</a>
    <a class="secondary" href="${APPSTORE_URL}">App Store (iPhone)</a>
  </div>
</body>
</html>`);
});

export default router;
