import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()

# Replace the processBulkImport function to handle chunking
old = '''  const processBulkImport = async () => {
    if (!bulkText.trim() || !API_URL) return;
    setBulkParsing(true); setBulkVisits([]); setBulkProgress("\\u23f3 Splitting visits...");
    try {'''

new = '''  const processBulkImport = async () => {
    if (!bulkText.trim() || !API_URL) return;
    setBulkParsing(true); setBulkVisits([]); setBulkProgress("\\u23f3 Splitting visits...");
    try {
      // Split long text into chunks if needed (>4000 chars = likely >10 visits)
      const fullText = bulkText.trim();
      const chunks = [];
      if (fullText.length > 4000) {
        // Find "FOLLOW UP" markers to split intelligently
        const markers = [];
        const regex = /FOLLOW UP (ON|TODAY|NOTES)/gi;
        let match;
        while ((match = regex.exec(fullText)) !== null) markers.push(match.index);
        if (markers.length > 8) {
          // Split into chunks of ~8 visits each
          const mid = Math.floor(markers.length / 2);
          const splitPoint = markers[mid];
          // Include diagnosis/header context in second chunk
          const headerEnd = fullText.indexOf("FOLLOW UP");
          const header = headerEnd > 0 ? fullText.slice(0, headerEnd) : "";
          chunks.push(fullText.slice(0, splitPoint));
          chunks.push(header + "\\n" + fullText.slice(splitPoint));
        } else {
          chunks.push(fullText);
        }
      } else {
        chunks.push(fullText);
      }
      setBulkProgress(chunks.length > 1 ? `\\u23f3 Processing ${chunks.length} chunks...` : "\\u23f3 Parsing visits...");'''

if old in c:
    c = c.replace(old, new, 1)
    print("1. Chunk splitting: OK")
else:
    print("1. Chunk splitting: FAILED - function start not found")

# Now wrap the API call in a loop over chunks and merge results
old_api = '''      const prompt = `You are a clinical data extraction AI. The user is pasting ALL visit history for a patient from another EMR system.'''

new_api = '''      let allVisits = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        if (chunks.length > 1) setBulkProgress(`\\u23f3 Processing chunk ${ci+1}/${chunks.length}...`);
        const chunkText = chunks[ci];
      const prompt = `You are a clinical data extraction AI. The user is pasting ALL visit history for a patient from another EMR system.'''

if old_api in c:
    c = c.replace(old_api, new_api, 1)
    print("2. Loop start: OK")
else:
    print("2. Loop start: FAILED")

# Replace the text insertion
old_text_insert = '` + bulkText.trim();'
new_text_insert = '` + chunkText;'
c = c.replace(old_text_insert, new_text_insert, 1)
print("3. Text var: OK")

# Replace the visits result handling to accumulate across chunks
old_result = '''      if (!Array.isArray(visits) || visits.length === 0) {
        setBulkProgress("\\u274c Could not parse visits. Try reformatting.");
        setBulkParsing(false);
        return;
      }

      visits.sort((a, b) => new Date(a.visit_date) - new Date(b.visit_date));
      setBulkVisits(visits);'''

new_result = '''      if (Array.isArray(visits) && visits.length > 0) {
        allVisits = allVisits.concat(visits);
      }
      } // end chunk loop

      if (allVisits.length === 0) {
        setBulkProgress("\\u274c Could not parse visits. Try reformatting.");
        setBulkParsing(false);
        return;
      }

      // Deduplicate by visit_date
      const seen = new Set();
      const deduped = [];
      allVisits.sort((a, b) => new Date(a.visit_date) - new Date(b.visit_date));
      for (const v of allVisits) {
        const key = v.visit_date;
        if (!seen.has(key)) { seen.add(key); deduped.push(v); }
      }
      setBulkVisits(deduped);'''

if old_result in c:
    c = c.replace(old_result, new_result, 1)
    print("4. Merge results: OK")
else:
    print("4. Merge results: FAILED - result block not found")

# Fix the success message to use deduped
old_success = '''setBulkProgress(`\\u2705 Found ${visits.length} visits. Review and click Save All.`);'''
new_success = '''setBulkProgress(`\\u2705 Found ${deduped.length} visits${chunks.length > 1 ? ` (from ${chunks.length} chunks)` : ""}. Review and click Save All.`);'''
if old_success in c:
    c = c.replace(old_success, new_success, 1)
    print("5. Success message: OK")
else:
    print("5. Success message: FAILED")

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
