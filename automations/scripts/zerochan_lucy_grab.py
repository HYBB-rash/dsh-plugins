#!/usr/bin/env python3
"""从 zerochan 角色页抓取露西图片原图链接(头像向)。"""
import json, sys, re, subprocess, urllib.request

def get_tab():
    tabs = json.loads(urllib.request.urlopen("http://127.0.0.1:9222/json").read())
    for t in tabs:
        if isinstance(t, dict) and t.get('type') == 'page' and 'zerochan' in t.get('url', ''):
            return t
    return None

def main():
    tab = get_tab()
    if not tab:
        print("NO_TAB")
        return
    ws = tab['webSocketDebuggerUrl']
    script = f"""
const ws = new WebSocket('{ws}');
let id=0; const pending={{}};
ws.onmessage=(e)=>{{const r=JSON.parse(e.data); if(r.id&&pending[r.id]){{pending[r.id](r);delete pending[r.id];}}}};
function cmd(m,p){{return new Promise(res=>{{const mid=++id;pending[mid]=res;ws.send(JSON.stringify({{id:mid,method:m,params:p||{{}}}}));}});}}
ws.onopen=async()=>{{
  await new Promise(r=>setTimeout(r,3000));
  const r=await cmd('Runtime.evaluate',{{expression:`(() => {{
    const out = [];
    document.querySelectorAll('a[href]').forEach(a => {{
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\\/(\\d+)$/);
      if (m) {{
        const img = a.querySelector('img');
        const src = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
        if (src && src.includes('zerochan') && !src.includes('logo')) out.push({{id: m[1], src}});
      }}
    }});
    return out.slice(0,60);
  }})()`, returnByValue:true}});
  process.stdout.write(JSON.stringify(r.result?.result?.value||[]));
  ws.close(); process.exit(0);
}};
setTimeout(()=>{{process.exit(1);}},15000);
"""
    r = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=25)
    m = re.search(r'\[.*\]', r.stdout, re.S)
    if not m:
        print("NO_JSON", r.stdout[:200])
        return
    items = json.loads(m.group(0))
    print(json.dumps(items, ensure_ascii=False))

if __name__ == "__main__":
    main()
