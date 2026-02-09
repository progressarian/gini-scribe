# Gini Clinical Scribe v6

Voice-to-structured clinical documentation for Gini Advanced Care Hospital.

## Deploy to Railway

```bash
git init && git add . && git commit -m "Gini Scribe v6"
# Create repo on github.com, then:
git remote add origin <your-repo-url>
git push -u origin main
```

Railway.app → New Project → Deploy from GitHub → Select repo

**Environment Variables:**
- `VITE_DEEPGRAM_KEY` = your Deepgram API key  
- `PORT` = 3000

## Local Dev
```bash
npm install
VITE_DEEPGRAM_KEY=your_key npm run dev
```
