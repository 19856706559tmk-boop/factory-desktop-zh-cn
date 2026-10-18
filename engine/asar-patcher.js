#!/usr/bin/env node
/**
 * Factory Desktop (v0.199.1+) Surgical ASAR Patcher + Integrity Sync + Entitlements Codesign
 * Compatible with both Node.js and Factory's bundled Bun runtime (`BUN_BE_BUN=1 .../bin/droid`).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function getRealUserInfo() {
  if (IS_WIN) {
    return {
      uid: 0,
      gid: 0,
      user: process.env.USERNAME || os.userInfo().username || 'user',
      home: os.homedir(),
      isSudo: false
    };
  }
  const curUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const curGid = typeof process.getgid === 'function' ? process.getgid() : 0;
  if (curUid !== 0) {
    return {
      uid: curUid,
      gid: curGid,
      user: process.env.USER || os.userInfo().username,
      home: os.homedir(),
      isSudo: false
    };
  }
  let realUid = Number(process.env.SUDO_UID || 0);
  let realGid = Number(process.env.SUDO_GID || 0);
  let realUser = process.env.SUDO_USER || '';
  if (!realUid) {
    try {
      const st = fs.statSync('/dev/console');
      if (st.uid > 0) {
        realUid = st.uid;
        realGid = st.gid;
      }
    } catch (_) {}
  }
  if (!realUser && realUid > 0) {
    try {
      realUser = execFileSync('/usr/bin/id', ['-un', String(realUid)], { encoding: 'utf8' }).trim();
    } catch (_) {}
  }
  let realHome = os.homedir();
  if (realUser && realUser !== 'root') {
    const candidate = path.join('/Users', realUser);
    if (fs.existsSync(candidate)) {
      realHome = candidate;
    }
  }
  return {
    uid: realUid || curUid,
    gid: realGid || curGid,
    user: realUser || 'root',
    home: realHome,
    isSudo: realUid > 0
  };
}

const REAL_USER = getRealUserInfo();
const PERSIST_DIR = path.join(REAL_USER.home, '.factory-zh');
const BACKUP_DIR = path.join(PERSIST_DIR, 'backup');

function parseSemverKey(name) {
  const m = String(name).match(/^app-(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function resolveWindowsAppDirFromRoot(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return null;
  if (fs.existsSync(path.join(rootDir, 'resources', 'app.asar'))) {
    return rootDir;
  }
  try {
    const subdirs = fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^app-/i.test(d.name))
      .sort((a, b) => {
        const ka = parseSemverKey(a.name);
        const kb = parseSemverKey(b.name);
        for (let i = 0; i < 3; i++) {
          if (kb[i] !== ka[i]) return kb[i] - ka[i];
        }
        return b.name.localeCompare(a.name);
      });
    for (const d of subdirs) {
      const candidate = path.join(rootDir, d.name);
      if (fs.existsSync(path.join(candidate, 'resources', 'app.asar'))) {
        return candidate;
      }
    }
  } catch (_) {}
  return null;
}

function resolveAppPath() {
  if (IS_WIN) {
    const winCandidates = [
      process.env.FACTORY_APP_PATH,
      path.join(process.env.LOCALAPPDATA || path.join(REAL_USER.home, 'AppData', 'Local'), 'Factory'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Factory')
    ].filter(Boolean);
    for (const c of winCandidates) {
      const resolved = resolveWindowsAppDirFromRoot(c);
      if (resolved) return resolved;
    }
    return path.join(process.env.LOCALAPPDATA || path.join(REAL_USER.home, 'AppData', 'Local'), 'Factory');
  }
  const candidates = [
    process.env.FACTORY_APP_PATH,
    '/Applications/Factory.app',
    path.join(REAL_USER.home, 'Applications/Factory.app')
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'Contents/Resources/app.asar'))) {
      return c;
    }
  }
  return '/Applications/Factory.app';
}

const APP_PATH = resolveAppPath();
const CONTENTS_PATH = IS_WIN ? APP_PATH : path.join(APP_PATH, 'Contents');
const RESOURCES_PATH = path.join(CONTENTS_PATH, IS_WIN ? 'resources' : 'Resources');
const ASAR_PATH = path.join(RESOURCES_PATH, 'app.asar');
const INFO_PLIST_PATH = path.join(CONTENTS_PATH, 'Info.plist');
const EXE_PATH = path.join(APP_PATH, 'factory-desktop.exe');
const DROID_BIN_PATH = path.join(RESOURCES_PATH, 'bin', IS_WIN ? 'droid.exe' : 'droid');
const STATE_FILE = path.join(BACKUP_DIR, 'patch-state.json');
const LOCK_DIR = IS_WIN
  ? path.join(os.tmpdir(), `factory-zh-${REAL_USER.user}.lock`)
  : `/tmp/factory-zh-${REAL_USER.uid}.lock`;

function chownToRealUser(targetPath) {
  if (IS_WIN || !REAL_USER.isSudo || !fs.existsSync(targetPath)) return;
  try {
    execFileSync('/usr/sbin/chown', ['-R', `${REAL_USER.uid}:${REAL_USER.gid}`, targetPath], {
      stdio: 'ignore'
    });
  } catch (_) {}
}

const MARKER_MAIN = '/* __FACTORY_ZH_MAIN_PATCH_V1__ */';
const MARKER_LIFECYCLE = '/* __FACTORY_ZH_LIFECYCLE_PATCH_V1__ */';
const MARKER_RENDERER = '/* __FACTORY_ZH_RENDERER_PATCH_V1__ */';
const MARKER_PRELOAD = '/* __FACTORY_ZH_PRELOAD_PATCH_V1__ */';

const ENTITLEMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.cs.allow-jit</key>
\t<true/>
\t<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
\t<true/>
\t<key>com.apple.security.cs.disable-library-validation</key>
\t<true/>
\t<key>com.apple.security.device.audio-input</key>
\t<true/>
\t<key>com.apple.security.device.camera</key>
\t<true/>
\t<key>com.apple.security.automation.apple-events</key>
\t<true/>
</dict>
</plist>
`;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {}
}

function acquireLock(maxWaitMs = 15000) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  chownToRealUser(PERSIST_DIR);
  // Clean up any legacy lock inside backup/ or repo dir
  try {
    fs.rmSync(path.join(BACKUP_DIR, '.patcher.lock'), { recursive: true, force: true });
    fs.rmSync(path.join(BASE_DIR, 'backup', '.patcher.lock'), { recursive: true, force: true });
  } catch (_) {}

  const deadline = Date.now() + maxWaitMs;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
      fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid), { encoding: 'utf8', mode: 0o600 });
      chownToRealUser(LOCK_DIR);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        let holderAlive = false;
        try {
          const pidStr = fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8').trim();
          const pid = Number(pidStr);
          if (pid > 0) {
            process.kill(pid, 0);
            holderAlive = true;
          }
        } catch (_) {
          holderAlive = false;
        }
        if (!holderAlive) {
          try {
            fs.rmSync(LOCK_DIR, { recursive: true, force: true });
            continue;
          } catch (__) {}
        }
        if (Date.now() < deadline) {
          sleepSync(200);
          continue;
        }
      }
      return false;
    }
  }
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (_) {}
}

function computeAsarHeaderHash(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const hdr16 = Buffer.alloc(16);
    fs.readSync(fd, hdr16, 0, 16, 0);
    const hStrlen = hdr16.readUInt32LE(12);
    const headerBuf = Buffer.alloc(hStrlen);
    fs.readSync(fd, headerBuf, 0, hStrlen, 16);
    return crypto.createHash('sha256').update(headerBuf).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function computeFileIntegrity(buf) {
  const blockSize = 4194304;
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) {
    const chunk = buf.subarray(i, Math.min(i + blockSize, buf.length));
    blocks.push(crypto.createHash('sha256').update(chunk).digest('hex'));
  }
  if (blocks.length === 0) {
    blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize,
    blocks
  };
}

function patchMainJs(src, roleMenus) {
  if (src.includes(MARKER_MAIN)) return src;
  const hookCode = `${MARKER_MAIN}
(function(){
  try {
    const electron = require("electron");
    if (electron && electron.Menu && !electron.Menu.__factoryZhPatched) {
      const origBuild = electron.Menu.buildFromTemplate.bind(electron.Menu);
      const roleMap = ${JSON.stringify(roleMenus)};
      function translateTpl(items) {
        if (!Array.isArray(items)) return items;
        return items.map(item => {
          if (!item || typeof item !== "object") return item;
          const copy = { ...item };
          if (copy.role && !copy.label) {
            const r = String(copy.role).toLowerCase();
            if (roleMap[r]) copy.label = roleMap[r];
          }
          if (Array.isArray(copy.submenu)) {
            copy.submenu = translateTpl(copy.submenu);
          }
          return copy;
        });
      }
      electron.Menu.buildFromTemplate = function(template) {
        try {
          const raw = JSON.stringify(template || []);
          const isZh = raw.includes("检查更新") || raw.includes("新建窗口") || raw.includes("复制链接") || !raw.includes("Check for Updates");
          if (isZh) {
            return origBuild(translateTpl(template));
          }
        } catch (_) {}
        return origBuild(template);
      };
      Object.defineProperty(electron.Menu, "__factoryZhPatched", { value: true });
    }
    if (process.platform === "darwin" && electron && electron.autoUpdater && !electron.autoUpdater.__factoryZhUpdaterPatched) {
      const au = electron.autoUpdater;
      const fs = require("fs");
      const path = require("path");
      const os = require("os");
      const { execFile, spawn } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);

      let feedUrl = "";
      let feedHeaders = {};
      let busy = false;
      let stagedAppPath = "";
      let stagedTmpDir = "";

      const setFeed = function(opts) {
        if (typeof opts === "string") {
          feedUrl = opts;
        } else if (opts && typeof opts === "object") {
          feedUrl = opts.url || "";
          feedHeaders = opts.headers || {};
        }
      };
      const getFeed = function() {
        return feedUrl;
      };
      const checkUpdates = async function() {
        if (busy) return;
        busy = true;
        let tmpDir = "";
        try {
          au.emit("checking-for-update");
          const url = feedUrl || ("https://downloads.factory.ai/factory-desktop/updates/darwin/" + process.arch + "/RELEASES.json");
          const resp = await electron.net.fetch(url, {
            headers: feedHeaders,
            cache: "no-store"
          });
          if (!resp.ok) {
            throw new Error("Update feed returned HTTP " + resp.status);
          }
          const feed = await resp.json();
          const currentRelease = feed && typeof feed.currentRelease === "string" ? feed.currentRelease.trim() : "";
          const appVer = electron.app.getVersion();
          const releases = Array.isArray(feed && feed.releases) ? feed.releases : [];
          const relEntry = releases.find(r => r && r.version === currentRelease) || releases[releases.length - 1];
          const updateTo = (relEntry && relEntry.updateTo) || relEntry;

          if (!currentRelease || currentRelease === appVer || !updateTo || !updateTo.url) {
            busy = false;
            au.emit("update-not-available");
            return;
          }

          au.emit("update-available");

          tmpDir = await fs.promises.mkdtemp(path.join("/private/tmp", "factory-zh-update-"));
          const zipPath = path.join(tmpDir, "update.zip");
          const extractDir = path.join(tmpDir, "extracted");
          await fs.promises.mkdir(extractDir, { recursive: true, mode: 0o700 });

          const dlResp = await electron.net.fetch(updateTo.url, {
            headers: feedHeaders,
            cache: "no-store"
          });
          if (!dlResp.ok || !dlResp.body) {
            throw new Error("Failed to download update package (HTTP " + dlResp.status + ")");
          }

          const fh = await fs.promises.open(zipPath, "wx", 0o600);
          const reader = dlResp.body.getReader();
          try {
            while (true) {
              const step = await reader.read();
              if (step.done) break;
              await fh.writeFile(step.value);
            }
          } finally {
            reader.releaseLock();
            await fh.close();
          }

          await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], {
            maxBuffer: 16 * 1024 * 1024
          });

          const newApp = path.join(extractDir, "Factory.app");
          if (!fs.existsSync(path.join(newApp, "Contents/Resources/app.asar"))) {
            throw new Error("Extracted update does not contain a valid Factory.app bundle");
          }

          await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp]);
          const csInfo = await execFileAsync("/usr/bin/codesign", ["-dvv", newApp]);
          const sigDetails = String(csInfo.stdout || "") + "\\n" + String(csInfo.stderr || "");
          if (!sigDetails.includes("Developer ID Application:") || !sigDetails.includes("Identifier=com.electron.factory")) {
            throw new Error("Downloaded update did not pass official Factory Developer ID signature verification");
          }

          const patcherScript = path.join(os.homedir(), ".factory-zh/engine/asar-patcher.js");
          if (fs.existsSync(patcherScript)) {
            const env = { ...process.env, FACTORY_APP_PATH: newApp };
            const nodeCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
            let runtimeBin = "";
            for (const c of nodeCandidates) {
              if (fs.existsSync(c)) {
                runtimeBin = c;
                break;
              }
            }
            if (!runtimeBin) {
              const bundledDroid = path.resolve(process.execPath, "../../Resources/bin/droid");
              const homeDroid = path.join(os.homedir(), ".local/bin/droid");
              if (fs.existsSync(bundledDroid)) {
                runtimeBin = bundledDroid;
                env.BUN_BE_BUN = "1";
              } else if (fs.existsSync(homeDroid)) {
                runtimeBin = homeDroid;
                env.BUN_BE_BUN = "1";
              } else {
                runtimeBin = "node";
              }
            }
            try {
              await execFileAsync(runtimeBin, [patcherScript], {
                env,
                timeout: 120000,
                maxBuffer: 16 * 1024 * 1024
              });
            } catch (_) {}
          }

          try {
            await fs.promises.unlink(zipPath);
          } catch (_) {}

          if (stagedTmpDir && stagedTmpDir !== tmpDir) {
            try {
              await fs.promises.rm(stagedTmpDir, { recursive: true, force: true });
            } catch (_) {}
          }
          stagedAppPath = newApp;
          stagedTmpDir = tmpDir;
          busy = false;

          au.emit(
            "update-downloaded",
            {},
            updateTo.notes || "",
            updateTo.version || currentRelease,
            new Date(updateTo.pub_date || Date.now()),
            updateTo.url
          );
        } catch (err) {
          busy = false;
          if (tmpDir) {
            try {
              await fs.promises.rm(tmpDir, { recursive: true, force: true });
            } catch (_) {}
          }
          au.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      };
      const quitInstall = function() {
        if (!stagedAppPath || !fs.existsSync(stagedAppPath)) {
          au.emit("error", new Error("Staged update bundle not found"));
          return;
        }
        au.emit("before-quit-for-update");
        const targetApp = path.resolve(process.execPath, "../../..");
        const pid = process.pid;
        const cleanupDir = stagedTmpDir;
        const staged = stagedAppPath;
        const backupMove = path.join(cleanupDir, "Factory.app.prev");

        const shScript = [
          "i=0",
          "while kill -0 " + pid + " 2>/dev/null && [ $i -lt 60 ]; do",
          "  sleep 0.25",
          "  i=$((i + 1))",
          "done",
          "sleep 0.3",
          "/bin/rm -rf \\"$3\\" 2>/dev/null || true",
          "if /bin/mv \\"$1\\" \\"$3\\" && /bin/mv \\"$2\\" \\"$1\\"; then",
          "  /bin/rm -rf \\"$4\\" 2>/dev/null || true",
          "  /usr/bin/open \\"$1\\"",
          "else",
          "  if [ ! -e \\"$1\\" ] && [ -e \\"$3\\" ]; then",
          "    /bin/mv \\"$3\\" \\"$1\\" 2>/dev/null || true",
          "  fi",
          "  /usr/bin/open \\"$1\\" 2>/dev/null || true",
          "fi"
        ].join("\\n");

        const child = spawn("/bin/sh", ["-c", shScript, "factory-zh-updater", targetApp, staged, backupMove, cleanupDir], {
          detached: true,
          stdio: "ignore"
        });
        child.unref();
        electron.app.quit();
      };

      for (const [k, fn] of Object.entries({
        setFeedURL: setFeed,
        getFeedURL: getFeed,
        checkForUpdates: checkUpdates,
        quitAndInstall: quitInstall
      })) {
        try {
          Object.defineProperty(au, k, { value: fn, configurable: true, writable: true });
        } catch (_) {
          try { au[k] = fn; } catch (__) {}
        }
      }
      Object.defineProperty(au, "__factoryZhUpdaterPatched", { value: true });
    }
  } catch (_) {}
})();
`;
  if (src.startsWith('"use strict";')) {
    return '"use strict";\n' + hookCode + src.slice('"use strict";'.length);
  }
  return hookCode + src;
}

function patchInitLifecycleJs(src, desktopBundle) {
  if (src.includes(MARKER_LIFECYCLE)) return src;
  let out = src;

  // 1. Add ChineseSimplified to supported desktop locales array (future-proof regardless of newly added languages or element order)
  out = out.replace(
    /=\[([^\]]*?([\w$]+)\.English\b)(?![^\]]*\.ChineseSimplified)/g,
    (_, prefix, enumVar) => `=[${prefix},${enumVar}.ChineseSimplified`
  );
  out = out.replace(
    /function ([\w$]+)\(\{saved:([\w$]+),candidates:([\w$]+)=\[\],supported:([\w$]+)\}\)\{/g,
    'function $1({saved:$2="zh-CN",candidates:$3=[],supported:$4}){if(!$2)$2="zh-CN";'
  );

  // 2. Inject ChineseSimplified desktop resource bundle and set initial lng to "zh-CN"
  const desktopJson = JSON.stringify(desktopBundle);
  out = out.replace(
    /([\w$]+)=\{\[([\w$]+)\.English\]:([\w$]+),/,
    (_, mapVar, enumVar, enVar) => `${mapVar}={"zh-CN":{desktop:${desktopJson}},[${enumVar}.English]:${enVar},`
  );
  out = out.replace(
    /\.init\(\{resources:([\w$]+),lng:([\w$]+),fallbackLng:\2,(?:supportedLngs:\[([^\]]+)\],)?/,
    (_, resVar, lngVar, supLngs) =>
      supLngs
        ? `.init({resources:${resVar},lng:"zh-CN",fallbackLng:${lngVar},supportedLngs:["zh-CN",${supLngs}],`
        : `.init({resources:${resVar},lng:"zh-CN",fallbackLng:${lngVar},`
  );

  // 3. Force AppLocalization flag enabled in main process
  out = out.replace(
    /([\w$]+)\.getFlag\(\1\.FactoryFeatureFlags\.AppLocalization\)/g,
    '!0'
  );

  if (!out.includes('"zh-CN":{desktop:')) {
    console.warn('[factory-zh] Notice: desktop i18next signature changed; relying on main.js role menu localization.');
  }

  return out + '\n' + MARKER_LIFECYCLE + '\n';
}

function patchRendererIndexJs(src, zhLocaleData) {
  if (src.includes(MARKER_RENDERER)) return src;
  let out = src;

  // 1. Add ChineseSimplified to supported renderer locales & Settings -> Language dropdown (future-proof across any newly added languages or element order)
  out = out.replace(
    /=\[([^\]]*?([\w$]+)\.English\b)(?![^\]]*\.ChineseSimplified)/g,
    (_, prefix, enumVar) => `=[${prefix},${enumVar}.ChineseSimplified`
  );
  out = out.replace(
    /function ([\w$]+)\(\{saved:([\w$]+),candidates:([\w$]+)=\[\],supported:([\w$]+)\}\)\{/g,
    'function $1({saved:$2="zh-CN",candidates:$3=[],supported:$4}){if(!$2)$2="zh-CN";'
  );

  // 2. Force AppLocalization feature flag enabled so Language selector in Preferences is always unlocked
  out = out.replace(
    /AppLocalization:\{displayName:"App Localization",statsigName:"app_localization",defaultValue:!1\}/g,
    'AppLocalization:{displayName:"App Localization",statsigName:"app_localization",defaultValue:!0}'
  );
  out = out.replace(
    /function ([\w$]+)\(([\w$]+)\)\{const\{flags:([\w$]+)\}=([\w$]+)\(\)/,
    (_, fnName, argName, hookVar, hookFn) => `function ${fnName}(${argName}){if(${argName}&&${argName}.statsigName==="app_localization")return!0;const{flags:${hookVar}}=${hookFn}()`
  );

  // 3. Inject __factoryBuildZh and register "zh-CN" in lazy loader map and i18next.init()
  const compactDict = {
    exact: zhLocaleData.exact,
    prefixes: zhLocaleData.prefixes,
    pathOverrides: zhLocaleData.pathOverrides || {}
  };
  const helperCode = `__FACTORY_ZH_I18N_DICT__=${JSON.stringify(compactDict)},__factoryBuildZh=function(rootObj){const exact=__FACTORY_ZH_I18N_DICT__.exact;const pathOverrides=__FACTORY_ZH_I18N_DICT__.pathOverrides||{};const lowerExact=Object.create(null);for(const k of Object.keys(exact)){const lk=k.toLowerCase();if(!lowerExact[lk])lowerExact[lk]=exact[k]}const prefixes=Object.entries(__FACTORY_ZH_I18N_DICT__.prefixes||{});function canLower(s){return s.length>=4&&s.length<=60&&!/^[A-Z0-9_./:-]+$/.test(s)}function tr(val,propKey,fullPath){if(typeof val==="string"){if(fullPath&&Object.prototype.hasOwnProperty.call(pathOverrides,fullPath))return pathOverrides[fullPath];if((propKey==="teams"||propKey==="manageTeams"||propKey==="sfTeams")&&val==="Teams")return"团队";if(propKey==="graphite"&&val==="Graphite")return"石墨灰";if(Object.prototype.hasOwnProperty.call(exact,val))return exact[val];if(/^(url|href|path|route|id|key|regex|pattern|command|cmd|env|mimeType)$/i.test(propKey))return val;const t=val.trim();if(t&&Object.prototype.hasOwnProperty.call(exact,t))return val.replace(t,()=>exact[t]);if(/^(https?:\\/\\/|\\/[a-z0-9_/-]+)$/i.test(t))return val;if(canLower(t)&&lowerExact[t.toLowerCase()])return val.replace(t,()=>lowerExact[t.toLowerCase()]);if(t.length>=2&&t.length<=85&&!/<[a-zA-Z0-9/_-]+>/.test(t)){for(let i=0;i<prefixes.length;i++){const[ep,zp]=prefixes[i];if(t.startsWith(ep)&&t.length>ep.length){const rest=t.slice(ep.length).trim();const zRest=Object.prototype.hasOwnProperty.call(exact,rest)?exact[rest]:(canLower(rest)?lowerExact[rest.toLowerCase()]:null);if(zRest)return val.replace(t,()=>zp+zRest);if(!/[a-z]{2,}/.test(rest.replace(/\\{\\{[^}]+\\}\\}/g,"")))return val.replace(t,()=>zp+t.slice(ep.length))}}}return val}if(Array.isArray(val))return val.map((v,idx)=>tr(v,"",fullPath?fullPath+"."+idx:String(idx)));if(val&&typeof val==="object"){const o={};for(const k of Object.keys(val))o[k]=tr(val[k],k,fullPath?fullPath+"."+k:k);if(propKey==="missionDefaults"&&o.label==="任务")o.label="任务模式";return o}return val}return tr(rootObj,"","")},`;

  // Capture the English resources variable name from .init({resources:{[BP]:$kt}
  const initMatch = out.match(/\.init\(\{resources:\{\[([\w$]+)\]:([\w$]+)\},lng:\1,fallbackLng:\1,/);
  const enResVar = initMatch ? initMatch[2] : '$kt';

  out = out.replace(
    /,([\w$]+)=\{\[([\w$]+)\.Japanese\]:/,
    (_, loaderMapVar, enumVar) => `,${helperCode}${loaderMapVar}={"zh-CN":async()=>({resources:__factoryBuildZh(${enResVar})}),[${enumVar}.Japanese]:`
  );

  out = out.replace(
    /\.init\(\{resources:\{\[([\w$]+)\]:([\w$]+)\},lng:\1,fallbackLng:\1,(?:supportedLngs:\[([^\]]+)\],)?/,
    (_, enKeyVar, resVar, supLngs) =>
      supLngs
        ? `.init({resources:{[${enKeyVar}]:${resVar},"zh-CN":__factoryBuildZh(${resVar})},lng:"zh-CN",fallbackLng:${enKeyVar},supportedLngs:["zh-CN",${supLngs}],`
        : `.init({resources:{[${enKeyVar}]:${resVar},"zh-CN":__factoryBuildZh(${resVar})},lng:"zh-CN",fallbackLng:${enKeyVar},`
  );

  if (!out.includes('__factoryBuildZh(')) {
    console.warn('[factory-zh] Notice: renderer i18next signature changed; relying on preload DOM localization engine.');
  }

  // 4. Localize hardcoded plan display names and billing price cadence formatters, and preserve app names
  out = out.replace(/displayName:"Pro Annual"/g, () => 'displayName:"Pro 年付版"');
  out = out.replace(/\?"Enterprise PAYG":"Enterprise"/g, () => '?"企业版（按量付费）":"企业版"');
  out = out.replace(/\?"Business PAYG":"Business"/g, () => '?"商业版（按量付费）":"商业版"');
  out = out.replace(/\/month \+ \$\$\{([\w$.]+)\}\/seat`/g, (_, expr) => `/月 + \${${expr}}/席位\``);
  out = out.replace(/\?"year":"month"\}`/g, () => '?"年":"月"}`');

  return out + '\n' + MARKER_RENDERER + '\n';
}

function patchPreloadJs(src, zhLocaleData, domTranslatorCode) {
  if (src.includes(MARKER_PRELOAD)) return src;
  const payload = `\n${MARKER_PRELOAD}\n(function(){\n  const __FACTORY_ZH_LOCALE_DATA__ = ${JSON.stringify({
    exact: zhLocaleData.exact,
    prefixes: zhLocaleData.prefixes
  })};\n  ${domTranslatorCode}\n})();\n`;
  return src + payload;
}

function updateInfoPlistIntegrity(plistPath, newHash) {
  let xml = fs.readFileSync(plistPath, 'utf8');
  const updated = xml.replace(
    /(<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash<\/key>\s*<string>)[0-9a-fA-F]{64}(<\/string>)/,
    `$1${newHash}$2`
  );
  if (updated === xml && !xml.includes(newHash)) {
    throw new Error('Failed to locate ElectronAsarIntegrity hash in Info.plist');
  }
  fs.writeFileSync(plistPath, updated, 'utf8');
}

const WIN_INTEGRITY_PREFIX = Buffer.from('[{"file":"resources\\\\app.asar","alg":"SHA256","value":"', 'utf8');

function readWindowsExeIntegrityHash(exePath) {
  if (!fs.existsSync(exePath)) return null;
  const buf = fs.readFileSync(exePath);
  const idx = buf.indexOf(WIN_INTEGRITY_PREFIX);
  if (idx === -1) return null;
  const hashStart = idx + WIN_INTEGRITY_PREFIX.length;
  return buf.subarray(hashStart, hashStart + 64).toString('utf8');
}

function updateWindowsExeIntegrity(exePath, newHash) {
  if (!fs.existsSync(exePath)) {
    throw new Error(`Executable not found: ${exePath}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(newHash)) {
    throw new Error(`Invalid SHA256 hash: ${newHash}`);
  }
  const buf = fs.readFileSync(exePath);
  let offset = 0;
  let count = 0;
  while (true) {
    const idx = buf.indexOf(WIN_INTEGRITY_PREFIX, offset);
    if (idx === -1) break;
    const hashStart = idx + WIN_INTEGRITY_PREFIX.length;
    Buffer.from(newHash.toLowerCase(), 'utf8').copy(buf, hashStart);
    count++;
    offset = hashStart + 64;
  }
  if (count === 0) {
    throw new Error('Failed to locate embedded ASAR integrity resource in factory-desktop.exe');
  }
  const tmpExe = `${exePath}.zh-tmp-${process.pid}`;
  fs.writeFileSync(tmpExe, buf);
  fs.renameSync(tmpExe, exePath);
}

function collectFilesRecursive(dirPath, filterFn, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, filterFn, out);
    } else if (entry.isFile() && filterFn(full)) {
      out.push(full);
    }
  }
  return out;
}

function codesignAppBundle(bundlePath) {
  const entPath = path.join(BACKUP_DIR, 'entitlements.plist');
  fs.writeFileSync(entPath, ENTITLEMENTS_XML, 'utf8');

  const contentsPath = path.join(bundlePath, 'Contents');
  const resourcesPath = path.join(contentsPath, 'Resources');
  const frameworksPath = path.join(contentsPath, 'Frameworks');

  const unpackedNodes = collectFilesRecursive(
    path.join(resourcesPath, 'app.asar.unpacked'),
    f => f.endsWith('.node') || f.endsWith('.dylib')
  );
  const resourceBins = collectFilesRecursive(
    path.join(resourcesPath, 'bin'),
    () => true
  );
  const frameworks = fs.existsSync(frameworksPath)
    ? fs.readdirSync(frameworksPath)
        .filter(n => n.endsWith('.framework'))
        .map(n => path.join(frameworksPath, n))
    : [];
  const helperApps = fs.existsSync(frameworksPath)
    ? fs.readdirSync(frameworksPath)
        .filter(n => n.endsWith('.app'))
        .map(n => path.join(frameworksPath, n))
    : [];

  const signPlain = [...unpackedNodes, ...resourceBins, ...frameworks];
  const signWithEnt = [...helperApps, bundlePath];

  for (const target of signPlain) {
    if (fs.existsSync(target)) {
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }
  }

  for (const target of signWithEnt) {
    if (fs.existsSync(target)) {
      execFileSync(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--timestamp=none', '--entitlements', entPath, target],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
  }

  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundlePath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function atomicSwapAppBundle(stagingAppPath, targetAppPath, workTmpDir) {
  const oldTmpPath = path.join(workTmpDir, 'Factory.app.old');
  fs.rmSync(oldTmpPath, { recursive: true, force: true });
  fs.renameSync(targetAppPath, oldTmpPath);
  try {
    fs.renameSync(stagingAppPath, targetAppPath);
  } catch (err) {
    // Rollback immediately if rename failed
    try {
      fs.renameSync(oldTmpPath, targetAppPath);
    } catch (_) {}
    throw err;
  }
  fs.rmSync(oldTmpPath, { recursive: true, force: true });
}

function verifyAsarBufferCompleteness(buf) {
  if (!buf || buf.length < 32) {
    throw new Error('ASAR buffer is too small or incomplete');
  }
  const hStrlen = buf.readUInt32LE(12);
  const aligned = (hStrlen + 3) & ~3;
  const dataOffset = 16 + aligned;
  if (buf.length < dataOffset) {
    throw new Error('ASAR header truncated');
  }
  const header = JSON.parse(buf.subarray(16, 16 + hStrlen).toString('utf8'));
  let maxEnd = dataOffset;
  function checkMax(node) {
    if (node.files) {
      for (const child of Object.values(node.files)) checkMax(child);
    } else if (!node.unpacked && node.offset !== undefined && node.size !== undefined) {
      const end = dataOffset + Number(node.offset) + Number(node.size);
      if (end > maxEnd) maxEnd = end;
    }
  }
  checkMax(header);
  if (buf.length < maxEnd) {
    throw new Error(`ASAR payload truncated (${buf.length} < ${maxEnd})`);
  }
  return { hStrlen, aligned, dataOffset, header };
}

function computePatchConfigHash() {
  const h = crypto.createHash('sha256');
  for (const rel of [
    'engine/asar-patcher.js',
    'engine/dom-translator.js',
    'locales/zh-CN.json',
    'locales/zh-desktop-i18n.json'
  ]) {
    const p = path.join(BASE_DIR, rel);
    if (fs.existsSync(p)) {
      h.update(fs.readFileSync(p));
    }
  }
  return h.digest('hex');
}

function isAlreadyPatched() {
  if (!fs.existsSync(STATE_FILE) || !fs.existsSync(ASAR_PATH)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const currentHash = computeAsarHeaderHash(ASAR_PATH);
    const configHash = computePatchConfigHash();
    if (IS_WIN) {
      const exeHash = readWindowsExeIntegrityHash(EXE_PATH);
      return (
        state.patchedHeaderHash === currentHash &&
        state.patchConfigHash === configHash &&
        exeHash === currentHash
      );
    }
    const plistXml = fs.readFileSync(INFO_PLIST_PATH, 'utf8');
    return (
      state.patchedHeaderHash === currentHash &&
      state.patchConfigHash === configHash &&
      plistXml.includes(currentHash)
    );
  } catch (_) {
    return false;
  }
}

function runPatch(options = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });

  if (!options.force && isAlreadyPatched()) {
    console.log('[factory-zh] Already patched and verified (ASAR header hash matches state).');
    return { status: 'already_patched' };
  }

  if (!acquireLock()) {
    console.log('[factory-zh] Another patch process is currently active; skipping.');
    return { status: 'locked' };
  }

  try {
    if (!options.force && isAlreadyPatched()) {
      console.log('[factory-zh] Already patched and verified (ASAR header hash matches state).');
      return { status: 'already_patched' };
    }

    const origBuf = fs.readFileSync(ASAR_PATH);
    const { dataOffset: oldDataOffset, header } = verifyAsarBufferCompleteness(origBuf);

    // Check if current app.asar is unpatched; if so, save clean backup
    const buildFiles = header.files['.vite'].files.build.files;
    const mainNode = buildFiles['main.js'];
    const mainContent = origBuf
      .subarray(oldDataOffset + Number(mainNode.offset), oldDataOffset + Number(mainNode.offset) + mainNode.size)
      .toString('utf8');

    const isCleanAsar = !mainContent.includes(MARKER_MAIN);
    const backupAsarPath = path.join(BACKUP_DIR, 'app.asar.orig');
    const backupPlistPath = path.join(BACKUP_DIR, 'Info.plist.orig');
    const backupExeHashPath = path.join(BACKUP_DIR, 'exe-integrity-hash.orig');

    if (isCleanAsar) {
      if (IS_WIN) {
        console.log('[factory-zh] Backing up clean original app.asar and factory-desktop.exe integrity hash...');
        fs.copyFileSync(ASAR_PATH, backupAsarPath + '.tmp');
        fs.renameSync(backupAsarPath + '.tmp', backupAsarPath);
        const origExeHash = readWindowsExeIntegrityHash(EXE_PATH) || computeAsarHeaderHash(ASAR_PATH);
        fs.writeFileSync(backupExeHashPath, origExeHash, 'utf8');
      } else {
        console.log('[factory-zh] Backing up clean original app.asar and Info.plist...');
        fs.copyFileSync(ASAR_PATH, backupAsarPath + '.tmp');
        fs.renameSync(backupAsarPath + '.tmp', backupAsarPath);
        fs.copyFileSync(INFO_PLIST_PATH, backupPlistPath + '.tmp');
        fs.renameSync(backupPlistPath + '.tmp', backupPlistPath);
      }
    } else if (fs.existsSync(backupAsarPath)) {
      console.log('[factory-zh] Re-patching from clean backup app.asar.orig...');
      const cleanBuf = fs.readFileSync(backupAsarPath);
      verifyAsarBufferCompleteness(cleanBuf);
      return runPatchFromBuffer(cleanBuf);
    }

    return runPatchFromBuffer(origBuf);
  } finally {
    releaseLock();
  }
}

function runPatchFromBuffer(origBuf) {
  const hStrlen = origBuf.readUInt32LE(12);
  const aligned = (hStrlen + 3) & ~3;
  const oldDataOffset = 16 + aligned;
  const header = JSON.parse(origBuf.subarray(16, 16 + hStrlen).toString('utf8'));

  const desktopData = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'locales/zh-desktop-i18n.json'), 'utf8'));
  const zhLocaleData = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'locales/zh-CN.json'), 'utf8'));
  const customTitlesPath = path.join(BACKUP_DIR, 'custom-session-titles.json');
  if (fs.existsSync(customTitlesPath)) {
    try {
      const customTitles = JSON.parse(fs.readFileSync(customTitlesPath, 'utf8'));
      if (customTitles && typeof customTitles === 'object' && zhLocaleData.exact) {
        Object.assign(zhLocaleData.exact, customTitles);
      }
    } catch (_) {}
  }
  const domTranslatorCode = fs.readFileSync(path.join(BASE_DIR, 'engine/dom-translator.js'), 'utf8');

  const buildFiles = header.files['.vite'].files.build.files;
  const rendererAssets = header.files['.vite'].files.renderer.files.main_window.files.assets.files;

  const lifecycleKey = Object.keys(buildFiles).find(k => /^initLifecycle-.*\.js$/.test(k));
  const rendererIndexKey = Object.keys(rendererAssets)
    .filter(k => /^index-.*\.js$/.test(k))
    .sort((a, b) => (rendererAssets[b].size || 0) - (rendererAssets[a].size || 0))[0];

  if (!lifecycleKey || !rendererIndexKey) {
    throw new Error('Could not locate initLifecycle or renderer index bundle in ASAR');
  }

  function readAsarFile(node) {
    const start = oldDataOffset + Number(node.offset);
    return origBuf.subarray(start, start + node.size).toString('utf8');
  }

  const patchedMain = patchMainJs(readAsarFile(buildFiles['main.js']), desktopData.roleMenus);
  const patchedLifecycle = patchInitLifecycleJs(readAsarFile(buildFiles[lifecycleKey]), desktopData.desktop);
  const patchedPreload = patchPreloadJs(readAsarFile(buildFiles['preload.js']), zhLocaleData, domTranslatorCode);
  const patchedRenderer = patchRendererIndexJs(readAsarFile(rendererAssets[rendererIndexKey]), zhLocaleData);

  const modifiedMap = new Map([
    ['.vite/build/main.js', Buffer.from(patchedMain, 'utf8')],
    [`.vite/build/${lifecycleKey}`, Buffer.from(patchedLifecycle, 'utf8')],
    ['.vite/build/preload.js', Buffer.from(patchedPreload, 'utf8')],
    [`.vite/renderer/main_window/assets/${rendererIndexKey}`, Buffer.from(patchedRenderer, 'utf8')]
  ]);

  let currentOffset = 0;
  const chunks = [];

  function rebuildTree(node, relPath) {
    if (node.files) {
      for (const [k, child] of Object.entries(node.files)) {
        rebuildTree(child, relPath ? `${relPath}/${k}` : k);
      }
    } else if (!node.unpacked && node.offset !== undefined) {
      if (modifiedMap.has(relPath)) {
        const newBuf = modifiedMap.get(relPath);
        node.size = newBuf.length;
        node.offset = String(currentOffset);
        node.integrity = computeFileIntegrity(newBuf);
        chunks.push(newBuf);
        currentOffset += newBuf.length;
      } else {
        const start = oldDataOffset + Number(node.offset);
        const slice = origBuf.subarray(start, start + node.size);
        node.offset = String(currentOffset);
        chunks.push(slice);
        currentOffset += slice.length;
      }
    }
  }

  rebuildTree(header, '');

  const newHeaderBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const newHStrlen = newHeaderBytes.length;
  const newAligned = (newHStrlen + 3) & ~3;
  const padLen = newAligned - newHStrlen;

  const prefix16 = Buffer.alloc(16);
  prefix16.writeUInt32LE(4, 0);
  prefix16.writeUInt32LE(newAligned + 8, 4);
  prefix16.writeUInt32LE(newAligned + 4, 8);
  prefix16.writeUInt32LE(newHStrlen, 12);

  const padBuf = Buffer.alloc(padLen, 0);
  const newHeaderHash = crypto.createHash('sha256').update(newHeaderBytes).digest('hex');

const DROID_OLD_TITLE_PROMPT = Buffer.from(
`\nYou are a helper that generates concise session titles for a session picker.

Input: one user message from the start of a session. It may be a request, command, pasted context, transcript, or a very short greeting.

Goal: name the user's actual task so they can recognize this session later.

Output contract:
- Output exactly one plain-text title.
- Use sentence case.
- Prefer 3-7 words and stay under 60 characters.
- Use concrete nouns and verbs from the user's goal.
- Do not output markdown, quotes, labels, explanations, or trailing punctuation.
- Do not output New Session, Untitled, or a generic greeting.
- Do not introduce yourself or mention assistant identity.
- Do not mention Claude, Anthropic, Droid, or Factory unless the user's task is explicitly about that entity.

Quality check before answering:
- Would this title fit naturally in a session list row?
- Is it about the user's task, not your response?
- Could it stay useful after a fork or resume?

Examples:
User: "fix the flaky cli e2e around title generation" -> Fix CLI title e2e
User: "summarize this meeting transcript about sandbox costs" -> Summarize sandbox cost meeting
User: "how do I set up MCP auth?" -> Set up MCP auth
User: "hi" -> Start new chat`,
  'utf8'
);

const DROID_NEW_TITLE_BASE = Buffer.from(
`\nYou are a helper that generates concise session titles in Simplified Chinese (zh-CN).

Input: one user message from the start of a session (request, command, context, or greeting).

Goal: name the user's actual task in Simplified Chinese so they can recognize this session later.

Output contract:
- Output ONLY one plain-text title written in Simplified Chinese (zh-CN).
- Always translate English tasks into concise Simplified Chinese (keep terms like MCP, CLI, API, Git, Opus, SDK).
- Prefer 4-14 Chinese characters and stay under 30 characters total.
- Use concrete Chinese verbs and nouns from the user's goal.
- Do not output markdown, quotes, labels, explanations, or trailing punctuation.
- Do not output New Session, Untitled, Start new chat, or a generic greeting.
- Do not introduce yourself or mention assistant identity.
- Do not mention Claude, Anthropic, Droid, or Factory unless the task is explicitly about it.

Quality check before answering:
- Is the title written in natural Simplified Chinese (zh-CN) with Chinese characters (Hanzi)?
- Is it about the user's task, not your response?

CRITICAL RULE: Output MUST be Simplified Chinese (zh-CN), never an English sentence.`,
  'utf8'
);

const DROID_NEW_TITLE_PROMPT = Buffer.concat([
  DROID_NEW_TITLE_BASE,
  Buffer.alloc(DROID_OLD_TITLE_PROMPT.length - DROID_NEW_TITLE_BASE.length, 0x20)
]);

function patchDroidBinaryInPlace(binaryPath, backupName) {
  if (!fs.existsSync(binaryPath)) return 0;
  const buf = fs.readFileSync(binaryPath);
  if (buf.indexOf(DROID_OLD_TITLE_PROMPT) === -1) {
    return 0;
  }
  // Because DROID_OLD_TITLE_PROMPT is present, binaryPath is guaranteed to be a clean,
  // unpatched official binary (either initial install or newly updated Factory version).
  // Always refresh the backup atomically so restore.py matches the exact current version.
  if (backupName) {
    const backupPath = path.join(BACKUP_DIR, backupName);
    const tmpBackup = `${backupPath}.tmp-${process.pid}`;
    try {
      fs.rmSync(tmpBackup, { force: true });
      if (!IS_WIN) {
        try {
          execFileSync('/bin/cp', ['-c', binaryPath, tmpBackup], { stdio: 'ignore' });
        } catch (_) {
          fs.copyFileSync(binaryPath, tmpBackup);
        }
      } else {
        fs.copyFileSync(binaryPath, tmpBackup);
      }
      fs.renameSync(tmpBackup, backupPath);
    } catch (_) {
      try {
        fs.rmSync(tmpBackup, { force: true });
      } catch (__) {}
    }
  }
  let count = 0;
  let offset = 0;
  while (true) {
    const idx = buf.indexOf(DROID_OLD_TITLE_PROMPT, offset);
    if (idx === -1) break;
    DROID_NEW_TITLE_PROMPT.copy(buf, idx);
    count++;
    offset = idx + DROID_OLD_TITLE_PROMPT.length;
  }
  if (count > 0) {
    const tmpPath = `${binaryPath}.zh-tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, buf, { mode: 0o755 });
    fs.renameSync(tmpPath, binaryPath);
  }
  return count;
}

  if (IS_WIN) {
    const stagingAsar = `${ASAR_PATH}.zh-tmp-${process.pid}`;
    const outFd = fs.openSync(stagingAsar, 'w', 0o644);
    try {
      fs.writeSync(outFd, prefix16);
      fs.writeSync(outFd, newHeaderBytes);
      if (padLen > 0) fs.writeSync(outFd, padBuf);
      for (const chunk of chunks) {
        fs.writeSync(outFd, chunk);
      }
    } finally {
      fs.closeSync(outFd);
    }
    fs.renameSync(stagingAsar, ASAR_PATH);

    try {
      const droidPatchedCount = patchDroidBinaryInPlace(DROID_BIN_PATH, 'droid.orig');
      if (droidPatchedCount > 0) {
        console.log(`[factory-zh] Patched Chinese session title generator in resources/bin/droid.exe (${droidPatchedCount} regions).`);
      }
    } catch (droidErr) {
      console.warn(`[factory-zh] Warning: resources/bin/droid.exe patch failed (${droidErr.message}); keeping original binary.`);
    }

    try {
      updateWindowsExeIntegrity(EXE_PATH, newHeaderHash);
    } catch (integrityErr) {
      // The patched asar is already in place but the embedded integrity hash would still
      // match the original, leaving the app unable to boot. Roll the asar back to the
      // original buffer (whose hash the exe still carries) to keep the app bootable.
      console.error(`[factory-zh] Exe integrity sync failed (${integrityErr.message}); rolling back app.asar to the original.`);
      try {
        const rollbackPath = `${ASAR_PATH}.zh-rollback-${process.pid}`;
        fs.writeFileSync(rollbackPath, origBuf);
        fs.renameSync(rollbackPath, ASAR_PATH);
      } catch (rollbackErr) {
        console.error(`[factory-zh] Rollback failed (${rollbackErr.message}); run restore.py to recover.`);
      }
      throw integrityErr;
    }
  } else {
    // Stage full APFS Copy-on-Write clone in a private 0700 temp directory to prevent /tmp symlink attacks
    const workTmpDir = fs.mkdtempSync('/private/tmp/factory-zh-');
    const stagingApp = path.join(workTmpDir, 'Factory.app.staging');

    try {
      execFileSync('/bin/cp', ['-cR', APP_PATH, stagingApp], { stdio: ['ignore', 'pipe', 'pipe'] });
      const stagingAsar = path.join(stagingApp, 'Contents/Resources/app.asar');
      const stagingPlist = path.join(stagingApp, 'Contents/Info.plist');
      const stagingDroid = path.join(stagingApp, 'Contents/Resources/bin/droid');

      const outFd = fs.openSync(stagingAsar, 'w', 0o644);
      try {
        fs.writeSync(outFd, prefix16);
        fs.writeSync(outFd, newHeaderBytes);
        if (padLen > 0) fs.writeSync(outFd, padBuf);
        for (const chunk of chunks) {
          fs.writeSync(outFd, chunk);
        }
      } finally {
        fs.closeSync(outFd);
      }

      try {
        const droidPatchedCount = patchDroidBinaryInPlace(stagingDroid, 'droid.orig');
        if (droidPatchedCount > 0) {
          execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', stagingDroid], {
            stdio: ['ignore', 'pipe', 'pipe']
          });
          console.log(`[factory-zh] Patched Chinese session title generator in Resources/bin/droid (${droidPatchedCount} regions).`);
        }
      } catch (droidErr) {
        console.warn(`[factory-zh] Warning: bin/droid patch/codesign failed (${droidErr.message}); falling back to original binary.`);
        const origDroidBackup = path.join(BACKUP_DIR, 'droid.orig');
        if (fs.existsSync(origDroidBackup)) {
          fs.copyFileSync(origDroidBackup, stagingDroid);
        } else if (fs.existsSync(path.join(APP_PATH, 'Contents/Resources/bin/droid'))) {
          fs.copyFileSync(path.join(APP_PATH, 'Contents/Resources/bin/droid'), stagingDroid);
        }
      }

      updateInfoPlistIntegrity(stagingPlist, newHeaderHash);
      codesignAppBundle(stagingApp);
      atomicSwapAppBundle(stagingApp, APP_PATH, workTmpDir);
    } finally {
      fs.rmSync(workTmpDir, { recursive: true, force: true });
    }
  }

  // Also patch standalone ~/.local/bin/droid(.exe) if present (using real user home, never /var/root)
  const localDroid = path.join(REAL_USER.home, '.local', 'bin', IS_WIN ? 'droid.exe' : 'droid');
  if (fs.existsSync(localDroid)) {
    try {
      const localCount = patchDroidBinaryInPlace(localDroid, 'local-droid.orig');
      if (localCount > 0) {
        if (!IS_WIN) {
          execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', localDroid], {
            stdio: ['ignore', 'pipe', 'pipe']
          });
          chownToRealUser(localDroid);
        }
        console.log(`[factory-zh] Patched ${localDroid} (${localCount} regions).`);
      }
    } catch (localErr) {
      console.warn(`[factory-zh] Warning: ${localDroid} patch failed (${localErr.message}); restoring original.`);
      const origLocalBackup = path.join(BACKUP_DIR, 'local-droid.orig');
      if (fs.existsSync(origLocalBackup)) {
        try {
          fs.copyFileSync(origLocalBackup, localDroid);
          chownToRealUser(localDroid);
        } catch (_) {}
      }
    }
  }

  const state = {
    patchedAt: new Date().toISOString(),
    patchedHeaderHash: newHeaderHash,
    patchConfigHash: computePatchConfigHash(),
    lifecycleBundle: lifecycleKey,
    rendererBundle: rendererIndexKey,
    appPath: APP_PATH
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  chownToRealUser(PERSIST_DIR);

  if (IS_WIN) {
    console.log(`[factory-zh] Successfully patched app.asar and synced factory-desktop.exe integrity (${newHeaderHash.slice(0, 16)}...)!`);
  } else {
    console.log(`[factory-zh] Successfully patched app.asar, synced Info.plist (${newHeaderHash.slice(0, 16)}...), and verified codesign!`);
  }
  return { status: 'patched', hash: newHeaderHash };
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    const ok = isAlreadyPatched();
    console.log(ok ? 'PATCHED' : 'UNPATCHED');
    process.exit(ok ? 0 : 1);
  }
  runPatch({ force });
}

module.exports = {
  runPatch,
  isAlreadyPatched,
  computeAsarHeaderHash,
  readWindowsExeIntegrityHash,
  updateWindowsExeIntegrity,
  patchMainJs,
  patchInitLifecycleJs,
  patchRendererIndexJs,
  patchPreloadJs,
  REAL_USER,
  PERSIST_DIR,
  BACKUP_DIR,
  APP_PATH,
  ASAR_PATH,
  EXE_PATH,
  DROID_BIN_PATH,
  STATE_FILE,
  chownToRealUser
};
