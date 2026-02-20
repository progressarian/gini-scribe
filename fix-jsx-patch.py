import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()

# The problem: AI brief code is inside the ternary between the button and ): 
# Need to move it after the entire ternary block closes

# Find the broken insertion point and fix
old = '''                  📋 Generate Consultant Brief
                </button>
              {patientFullData && ('''

new = '''                  📋 Generate Consultant Brief
                </button>
              ) : ('''

# First, fix the broken ternary by restoring the ) : ( 
if old in c:
    c = c.replace(old, new, 1)
    print("1. Fixed ternary opening: OK")
else:
    print("1. FAILED - broken pattern not found")

# Now find where the moBrief ternary closes and the AI brief section
# The ternary should end with )} after the structured brief panel
# Then we need to put the AI brief AFTER the entire ternary

# Find the closing of the moBrief display panel
# It ends with </div>\n            )}\n
# Then we add AI brief after the </div> that closes the {dbPatientId && ( wrapper's content

# Find the aiBrief section that's currently misplaced
ai_section_start = c.find('{patientFullData && (\n                <button onClick={generateAIBrief}')
if ai_section_start == -1:
    ai_section_start = c.find('{patientFullData && (\n                  <button onClick={generateAIBrief}')

if ai_section_start > 0:
    # Find where the aiBrief section ends (after the closing of aiBrief display div)
    # Look for the pattern that ends the aiBrief block
    # It ends with </div>\n              )}
    # Find consecutive closing patterns
    search_from = ai_section_start
    # Find 'AI CLINICAL BRIEF' then find its closing divs
    ai_brief_display_end = c.find("</div>\n              )}", search_from)
    if ai_brief_display_end > 0:
        # There might be two )} blocks - one for aiBrief display, then continue
        # Let's find all the AI brief content
        pass

    print(f"2. AI section found at {ai_section_start}")
else:
    print("2. AI section not found in broken position")

# SIMPLER APPROACH: Remove the entire AI section from wrong place and re-add it correctly

# Extract the AI brief JSX block
ai_btn_and_display = '''              {patientFullData && (
                <button onClick={generateAIBrief} disabled={aiBriefLoading}
                  style={{ width:"100%", marginTop:6, background: aiBriefLoading ? "#94a3b8" : "linear-gradient(135deg,#7c3aed,#a855f7)", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:aiBriefLoading?"wait":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                  {aiBriefLoading ? "\\u23f3 Generating AI Brief..." : "\\U0001f9e0 AI Clinical Brief"}
                </button>
              )}
              {aiBrief && (
                <div style={{ marginTop:8, border:"2px solid #7c3aed", borderRadius:10, overflow:"hidden" }}>
                  <div style={{ background:"linear-gradient(135deg,#7c3aed,#6d28d9)", color:"white", padding:"8px 12px", display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:14 }}>\\U0001f9e0</span>
                    <div style={{ flex:1, fontWeight:800, fontSize:13 }}>AI CLINICAL BRIEF</div>
                    <button onClick={()=>{ navigator.clipboard.writeText(aiBrief); }}
                      style={{ background:"rgba(255,255,255,.2)", border:"none", color:"white", padding:"4px 10px", borderRadius:5, fontSize:10, fontWeight:700, cursor:"pointer" }}>\\U0001f4cb Copy</button>
                    <button onClick={()=>setAiBrief(null)}
                      style={{ background:"rgba(255,255,255,.1)", border:"none", color:"white", padding:"4px 6px", borderRadius:5, fontSize:10, cursor:"pointer" }}>\\u2715</button>
                  </div>
                  <div style={{ padding:12, fontSize:12, lineHeight:1.8, color:"#1e293b", whiteSpace:"pre-wrap", maxHeight:500, overflowY:"auto", background:"#faf5ff" }}>
                    {aiBrief.split(/\\*\\*(.*?)\\*\\*/g).map((part, i) => 
                      i % 2 === 1 
                        ? <div key={i} style={{ fontWeight:800, fontSize:11, color:"#7c3aed", marginTop:i>1?12:0, marginBottom:4, textTransform:"uppercase", letterSpacing:".5px", borderBottom:"1px solid #e9d5ff", paddingBottom:3 }}>{part}</div>
                        : <span key={i}>{part}</span>
                    )}
                  </div>
                </div>
              )}'''

# Remove AI section from where it's wrongly placed
if ai_btn_and_display in c:
    c = c.replace(ai_btn_and_display, '', 1)
    print("3. Removed misplaced AI section: OK")
else:
    # Try to find and remove it by finding the start and end markers
    start_marker = '{patientFullData && (\n                <button onClick={generateAIBrief}'
    if start_marker in c:
        s_idx = c.find(start_marker)
        # Find the end - look for the closing of aiBrief display
        # Count from aiBrief display end
        e_search = c.find('</div>\n              )}', s_idx + 100)
        if e_search > 0:
            # There are two )} closings - one for patientFullData, one for aiBrief
            second_close = c.find('</div>\n              )}', e_search + 10)
            if second_close > 0 and second_close - s_idx < 3000:
                end_idx = second_close + len('</div>\n              )}')
                removed = c[s_idx:end_idx]
                c = c[:s_idx] + c[end_idx:]
                print(f"3. Removed misplaced AI section (manual): OK ({len(removed)} chars)")
            else:
                print("3. Could not find second close")
        else:
            print("3. Could not find first close")
    else:
        print("3. AI section already removed or not found")

# Now add AI brief in the correct place — AFTER the entire moBrief ternary block
# Find the closing </div> of the {dbPatientId && ( wrapper
# Pattern: the moBrief block ends, then </div>\n          )}\n
# Look for the end of the MO BRIEF section

# The structure is:
# {dbPatientId && (
#   <div style={{ marginBottom:10 }}>
#     {!moBrief ? (<button/>) : (<div>...brief panel...</div>)}
#   </div>
# )}

# Find '</div>\n          )}\n' after the brief panel
brief_section_marker = '{/* ── MO BRIEF FOR CONSULTANT ── */}'
brief_idx = c.find(brief_section_marker)
if brief_idx > 0:
    # Find the closing of this entire section
    # It's {dbPatientId && (\n  <div>...\n  </div>\n)}
    # Find the </div> + )} that closes the dbPatientId block
    # Search forward for the pattern
    
    # Find the marginBottom:10 div
    margin_div = c.find('marginBottom:10', brief_idx)
    if margin_div > 0:
        # Count divs to find the matching close
        # Easier: find the next {/* comment or major section after the brief
        next_section = c.find('{/* ', brief_idx + 50)
        if next_section > 0:
            # The closing )} is somewhere between margin_div and next_section
            # Find the last )} before next_section
            close_search = c.rfind(')}\n', margin_div, next_section)
            if close_search > 0:
                # Go back one more to find the </div> before it
                div_close = c.rfind('</div>', margin_div, close_search)
                if div_close > 0:
                    insert_point = close_search + len(')}\n')
                    
                    ai_brief_jsx = '''
          {/* ── AI CLINICAL BRIEF ── */}
          {dbPatientId && patientFullData && (
            <div style={{ marginBottom:10 }}>
              <button onClick={generateAIBrief} disabled={aiBriefLoading}
                style={{ width:"100%", background: aiBriefLoading ? "#94a3b8" : "linear-gradient(135deg,#7c3aed,#a855f7)", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:aiBriefLoading?"wait":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                {aiBriefLoading ? "\u23f3 Generating AI Brief..." : "\U0001f9e0 AI Clinical Brief"}
              </button>
              {aiBrief && (
                <div style={{ marginTop:8, border:"2px solid #7c3aed", borderRadius:10, overflow:"hidden" }}>
                  <div style={{ background:"linear-gradient(135deg,#7c3aed,#6d28d9)", color:"white", padding:"8px 12px", display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:14 }}>\U0001f9e0</span>
                    <div style={{ flex:1, fontWeight:800, fontSize:13 }}>AI CLINICAL BRIEF</div>
                    <button onClick={()=>{ navigator.clipboard.writeText(aiBrief); }}
                      style={{ background:"rgba(255,255,255,.2)", border:"none", color:"white", padding:"4px 10px", borderRadius:5, fontSize:10, fontWeight:700, cursor:"pointer" }}>\U0001f4cb Copy</button>
                    <button onClick={()=>setAiBrief(null)}
                      style={{ background:"rgba(255,255,255,.1)", border:"none", color:"white", padding:"4px 6px", borderRadius:5, fontSize:10, cursor:"pointer" }}>\u2715</button>
                  </div>
                  <div style={{ padding:12, fontSize:12, lineHeight:1.8, color:"#1e293b", whiteSpace:"pre-wrap", maxHeight:500, overflowY:"auto", background:"#faf5ff" }}>
                    {aiBrief.split(/\\*\\*(.*?)\\*\\*/g).map((part, i) => 
                      i % 2 === 1 
                        ? <div key={i} style={{ fontWeight:800, fontSize:11, color:"#7c3aed", marginTop:i>1?12:0, marginBottom:4, textTransform:"uppercase", letterSpacing:".5px", borderBottom:"1px solid #e9d5ff", paddingBottom:3 }}>{part}</div>
                        : <span key={i}>{part}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
'''
                    c = c[:insert_point] + ai_brief_jsx + c[insert_point:]
                    print("4. AI brief UI inserted correctly: OK")
                else:
                    print("4. FAILED - no </div> before close")
            else:
                print("4. FAILED - no )} found")
        else:
            print("4. FAILED - no next section found")
    else:
        print("4. FAILED - no marginBottom div")
else:
    print("4. FAILED - brief section marker not found")

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
