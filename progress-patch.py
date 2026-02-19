import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()

old = '      text += `SUMMARY:\\n${getPlan("summary", conData.assessment_summary)}\\n\\n`;'

progress = '''      // Clinical Progress (longitudinal)
      const brief = generateMOBrief();
      if (brief && brief.isFollowUp && brief.totalVisits > 1) {
        text += `CLINICAL PROGRESS:\\n`;
        text += `Under care for ${brief.monthsUnderCare} months (${brief.totalVisits} visits).\\n`;
        if (brief.weightTrend) text += `Weight: ${brief.weightTrend}.\\n`;
        if (brief.bpTrend) text += `BP trend: ${brief.bpTrend}.\\n`;
        const imp = brief.labTrends.filter(l => l.trend === "improving");
        const wrs = brief.labTrends.filter(l => l.trend === "worsening");
        if (imp.length) text += `Improving: ${imp.map(l => l.name + " " + (l.trajectory || l.previous+"\\u2192"+l.latest+l.latestUnit)).join("; ")}.\\n`;
        if (wrs.length) text += `Needs attention: ${wrs.map(l => l.name + " " + (l.trajectory || l.previous+"\\u2192"+l.latest+l.latestUnit)).join("; ")}.\\n`;
        if (brief.medChanges.length) text += `Med changes: ${brief.medChanges.map(c => (c.type === "added" ? "Added" : "Stopped") + " " + c.name).join(", ")}.\\n`;
        text += `\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n`;
      }
      text += `SUMMARY:\\n${getPlan("summary", conData.assessment_summary)}\\n\\n`;'''

if old in c:
    c = c.replace(old, progress, 1)
    print("OK" if "CLINICAL PROGRESS" in c else "FAILED")
else:
    print("FAILED - could not find target string")
    # Debug: show what's around SUMMARY
    idx = c.find('SUMMARY')
    if idx > 0:
        print("Found SUMMARY at index", idx)
        print("Context:", repr(c[idx-20:idx+80]))

f=open(path,'w'); f.write(c); f.close()
