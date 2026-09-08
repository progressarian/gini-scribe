import { Router } from "express";

const router = Router();

const PLAY_URL = "https://play.google.com/store/apps/details?id=com.gini.myhealthgenie";
const APPSTORE_URL = "https://apps.apple.com/in/app/id6787960972";

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
  p { color:#6b7280; margin:0 0 28px; font-size:15px; }
  a { display:block; padding:14px 20px; margin:10px 0; border-radius:12px;
      text-decoration:none; font-weight:600; background:#0d9488; color:#fff; }
  a.secondary { background:#fff; color:#0d9488; border:1px solid #0d9488; }
</style>
</head>
<body>
  <div class="card">
    <h1>Download My Gini</h1>
    <p>Open this link on your phone, or pick your store below.</p>
    <a href="${PLAY_URL}">Google Play (Android)</a>
    <a class="secondary" href="${APPSTORE_URL}">App Store (iPhone)</a>
  </div>
</body>
</html>`);
});

export default router;
