import fs from 'fs';
import path from 'path';

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) {
      const c = fs.readFileSync(p, 'utf8');
      if (/startup|autorun|autostart|Registry|reg add|Start Up|startmenu|Startuptask|nssm|RunOnce|HKLM|HKCU|scheduled|persist/i.test(c)) {
        console.log(p);
      }
    }
  }
}
walk('src');
