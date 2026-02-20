import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()

# Fix 1: Handle both instructions field names in UI
old = 'conData.follow_up.instructions && <div style={{ fontSize:11, color:"#475569", marginTop:4, padding:"4px 8px", background:"#fef3c7", borderRadius:4, border:"1px solid #fde68a" }}>{"\u26a0\ufe0f "}{conData.follow_up.instructions}</div>'
new = '(conData.follow_up.instructions||conData.follow_up.special_instructions) && <div style={{ fontSize:11, color:"#475569", marginTop:4, padding:"4px 8px", background:"#fef3c7", borderRadius:4, border:"1px solid #fde68a" }}>{"\u26a0\ufe0f "}{conData.follow_up.instructions||conData.follow_up.special_instructions}</div>'
if old in c:
    c = c.replace(old, new, 1)
    print('1. Instructions UI: OK')
else:
    print('1. Instructions UI: FAILED')

# Fix 2: Text export instructions
old2 = 'if (conData.follow_up.instructions) text += `Instructions: ${conData.follow_up.instructions}\\n`;'
new2 = 'if (conData.follow_up.instructions||conData.follow_up.special_instructions) text += `Instructions: ${conData.follow_up.instructions||conData.follow_up.special_instructions}\\n`;'
if old2 in c:
    c = c.replace(old2, new2, 1)
    print('2. Text instructions: OK')
else:
    print('2. Text instructions: FAILED')

# Fix 3: Normalize follow_up after AI response
old3 = 'else if(data) { console.log("conData follow_up:", JSON.stringify(data.follow_up)); setConData(fixConMedicines(data)); }'
new3 = r'''else if(data) {
            if (data.follow_up) {
              if (!data.follow_up.instructions && data.follow_up.special_instructions) data.follow_up.instructions = data.follow_up.special_instructions;
              if (data.follow_up.date) {
                const dm = String(data.follow_up.date).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
                if (dm) data.follow_up.date = dm[3]+"-"+dm[2].padStart(2,"0")+"-"+dm[1].padStart(2,"0");
              }
              if (!data.follow_up.date) {
                const src = conTranscript || quickTranscript || "";
                const fm = src.match(/(?:follow.?up|next.?visit|scheduled\s+on)[^\d]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i);
                if (fm) { const yr = fm[3].length===2 ? "20"+fm[3] : fm[3]; data.follow_up.date = yr+"-"+fm[2].padStart(2,"0")+"-"+fm[1].padStart(2,"0"); }
              }
            }
            console.log("conData follow_up:", JSON.stringify(data.follow_up));
            setConData(fixConMedicines(data));
          }'''
if old3 in c:
    c = c.replace(old3, new3, 1)
    print('3. Normalizer + fallback: OK')
else:
    print('3. Normalizer: FAILED')

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
