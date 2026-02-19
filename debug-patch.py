f=open('src/App.jsx','r'); c=f.read(); f.close()

old = '''const result = await resp.json();
      const text = (result.content?.[0]?.text || "").trim();'''

new = '''const result = await resp.json();
      console.log('Bulk API response:', JSON.stringify(result).slice(0,500));
      if (result.error) { setBulkProgress("API error: " + result.error.message); setBulkParsing(false); return; }
      const text = (result.content?.[0]?.text || "").trim();
      console.log('Parsed text:', text.slice(0,200));
      if (text.length === 0) { setBulkProgress("Empty response from AI"); setBulkParsing(false); return; }'''

c = c.replace(old, new, 1)
print('OK' if 'Bulk API response' in c else 'FAILED')
f=open('src/App.jsx','w'); f.write(c); f.close()
