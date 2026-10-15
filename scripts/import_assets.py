#!/usr/bin/env python3
"""
Google ドライブのアセット群（GPT 制作の GLB）をゲームに取り込む。

  python3 scripts/import_assets.py library   … ダウンロード・展開・重ね合わせ・寸法計測（作業フォルダに全件の台帳）
  python3 scripts/import_assets.py select    … scripts/asset_selection.json に従って public/assets/models へ書き出す
  python3 scripts/import_assets.py all       … 両方

作業フォルダ: 環境変数 ASSET_WORK（既定: リポジトリ直下の .asset-work/。git 管理外）

取り込みの決まり（制作側の引き継ぎ資料 Game6_1240_Integration_Handoff に従う）:
  ・GLB はメートル・Y-up。原点はそのまま使う（状態ごとに接地補正しない）
  ・状態は normal / lod1 / lod2 / wreck。ファイル名から推測せず、models/<id>/<state>.glb などの実パスで判別
  ・ゲームに入れるのは runtime 版だけ（baseline・qa・candidate・preview は除外）
  ・Babylon.js の glTF ローダーは「..」を含む画像 URI を拒否するので、書き出し時に textures/ 直下へ平らにする
"""
import hashlib, json, os, re, shutil, struct, subprocess, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get("ASSET_WORK", os.path.join(ROOT, ".asset-work"))
SOURCES = json.load(open(os.path.join(ROOT, "scripts", "asset_sources.json")))["sources"]
STATES = ("normal", "lod1", "lod2", "wreck")

# ------------------------------------------------------------------ GLB の読み書き
def read_glb(path):
    b = open(path, "rb").read()
    magic, ver, _ = struct.unpack("<III", b[:12])
    if magic != 0x46546C67:
        raise ValueError("not glb: " + path)
    jlen, jtype = struct.unpack("<II", b[12:20])
    return ver, jtype, json.loads(b[20:20 + jlen]), b[20 + jlen:]

def write_glb(path, ver, jtype, j, rest):
    js = json.dumps(j, separators=(",", ":"), ensure_ascii=False).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, ver, 12 + 8 + len(js) + len(rest)))
        f.write(struct.pack("<II", len(js), jtype))
        f.write(js)
        f.write(rest)

def mat_mul(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]

def node_matrix(n):
    if "matrix" in n:
        m = n["matrix"]  # 列優先 → 行優先へ
        return [m[c * 4 + r] for r in range(4) for c in range(4)]
    t = n.get("translation", [0, 0, 0])
    q = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    x, y, z, w = q
    R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
         2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
         2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    return [R[0] * s[0], R[1] * s[1], R[2] * s[2], t[0],
            R[3] * s[0], R[4] * s[1], R[5] * s[2], t[1],
            R[6] * s[0], R[7] * s[1], R[8] * s[2], t[2],
            0, 0, 0, 1]

def glb_info(path):
    """シーンのノード変換を適用した外接箱と三角形数（glTF 座標 = Y-up 右手系）"""
    _, _, j, _ = read_glb(path)
    nodes = j.get("nodes", [])
    meshes = j.get("meshes", [])
    acc = j.get("accessors", [])
    lo = [1e18] * 3
    hi = [-1e18] * 3
    tris = 0
    I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    def visit(ni, parent):
        nonlocal tris
        n = nodes[ni]
        M = mat_mul(parent, node_matrix(n))
        if "mesh" in n:
            for p in meshes[n["mesh"]]["primitives"]:
                a = acc[p["attributes"]["POSITION"]]
                mn, mx = a.get("min"), a.get("max")
                if mn and mx:
                    for cx in (mn[0], mx[0]):
                        for cy in (mn[1], mx[1]):
                            for cz in (mn[2], mx[2]):
                                v = [M[r * 4] * cx + M[r * 4 + 1] * cy + M[r * 4 + 2] * cz + M[r * 4 + 3] for r in range(3)]
                                for k in range(3):
                                    lo[k] = min(lo[k], v[k])
                                    hi[k] = max(hi[k], v[k])
                if "indices" in p:
                    tris += acc[p["indices"]]["count"] // 3
                else:
                    tris += a["count"] // 3
        for c in n.get("children", []):
            visit(c, M)

    scene = j.get("scenes", [{}])[j.get("scene", 0)]
    for r in scene.get("nodes", []):
        visit(r, I)
    if lo[0] > hi[0]:
        lo = hi = [0, 0, 0]
    return {"min": [round(v, 3) for v in lo], "max": [round(v, 3) for v in hi], "tris": tris}

# ------------------------------------------------------------------ library: ダウンロード〜台帳
STATE_RE = re.compile(r"(?:^|_)(normal|lod1|lod2|wreck)\.glb$", re.I)

def classify(rel):
    """ZIP 内のパスから (id, state) を返す。対象外は None"""
    low = rel.lower()
    if any(k in low for k in ("/baseline/", "baseline/", "/qa/", "/candidate/", "preview", "/sources/", "/editor")):
        if not low.startswith("texturedexisting1240/models/"):
            return None
    if not low.endswith(".glb"):
        return None
    ok = "/runtime/" in "/" + low or low.startswith("texturedexisting1240/models/") or re.match(r"^models/[^/]+/[^/]+\.glb$", low)
    if not ok:
        return None
    fn = os.path.basename(rel)
    m = STATE_RE.search(fn)
    if not m:
        return None
    state = m.group(1).lower()
    stem = fn[: m.start()].rstrip("_")
    parent = os.path.basename(os.path.dirname(rel))
    aid = stem if stem else parent
    if parent not in ("glb", "models", "runtime") and stem and stem != parent and not stem.startswith(parent):
        aid = parent
    return aid, state

def download(src, dst):
    url = f"https://drive.usercontent.google.com/download?id={src['id']}&export=download&confirm=t"
    subprocess.run(["curl", "-sSL", "-m", "1200", "-o", dst, url], check=True)

def library():
    dl = os.path.join(WORK, "downloads")
    ex = os.path.join(WORK, "extract")
    lib = os.path.join(WORK, "library")
    os.makedirs(dl, exist_ok=True)
    os.makedirs(ex, exist_ok=True)
    if os.path.exists(lib):
        shutil.rmtree(lib)
    os.makedirs(lib)
    order = sorted(SOURCES, key=lambda s: (s["folder"], s["created"]))
    picks = {}  # (id,state) -> 実ファイル
    names = {}
    for s in order:
        zp = os.path.join(dl, s["name"] + ".zip")
        if not os.path.exists(zp) or os.path.getsize(zp) < 1000:
            print("download", s["name"])
            download(s, zp)
        out = os.path.join(ex, s["name"])
        if not os.path.exists(out):
            with zipfile.ZipFile(zp) as z:
                z.extractall(out)
            if s.get("nested"):
                for dp, _, fs in os.walk(out):
                    for f in fs:
                        if f.endswith(".zip"):
                            with zipfile.ZipFile(os.path.join(dp, f)) as z:
                                z.extractall(out)
        n = 0
        for dp, _, fs in os.walk(out):
            for f in fs:
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, out).replace(os.sep, "/")
                if f.endswith(".json") and os.path.getsize(full) < 30_000_000:
                    collect_names(full, names)
                c = classify(rel)
                if c:
                    picks[c] = full
                    n += 1
        print(f"{s['name']}: {n} glb")
    # テクスチャの索引（URI が届かないときにファイル名で探す）
    tex_index = {}
    for dp, _, fs in os.walk(ex):
        for f in fs:
            if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".ktx2")):
                tex_index.setdefault(f, os.path.join(dp, f))
    catalog = {}
    for (aid, st), path in sorted(picks.items()):
        d = os.path.join(lib, aid)
        os.makedirs(d, exist_ok=True)
        ver, jt, j, rest = read_glb(path)
        deps = []
        for img in j.get("images", []):
            u = img.get("uri")
            if not u or u.startswith("data:"):
                continue
            src = os.path.normpath(os.path.join(os.path.dirname(path), u))
            if not os.path.exists(src):
                src = tex_index.get(os.path.basename(u))
            if not src:
                print("  missing texture", aid, st, u)
                continue
            deps.append(src)
            img["uri"] = os.path.relpath(src, d)  # パック作成（scripts/build_packs.mjs）が実体を読む
        write_glb(os.path.join(d, st + ".glb"), ver, jt, j, rest)
        info = glb_info(path)
        e = catalog.setdefault(aid, {"id": aid, "name": names.get(aid, aid), "states": {}})
        e["states"][st] = {"bytes": os.path.getsize(path), "tex": len(deps), **info}
    json.dump(catalog, open(os.path.join(WORK, "catalog_full.json"), "w"), ensure_ascii=False, indent=1)
    print(f"library: {len(catalog)} assets, {sum(len(e['states']) for e in catalog.values())} glb")

def collect_names(path, names):
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception:
        return
    stack = [data]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            i = o.get("id") or o.get("asset_id")
            nm = o.get("name_ja") or o.get("nameJa") or o.get("display_name_ja") or o.get("title_ja")
            if isinstance(i, str) and isinstance(nm, str) and i not in names:
                names[i] = nm
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)

# ------------------------------------------------------------------ select: ゲームへ書き出し
def select():
    sel = json.load(open(os.path.join(ROOT, "scripts", "asset_selection.json")))
    full = json.load(open(os.path.join(WORK, "catalog_full.json")))
    lib = os.path.join(WORK, "library")
    out = os.path.join(ROOT, "public", "assets", "models")
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, "textures"))
    tex_names = {}  # 元パス → 書き出し名
    used_names = {}
    result = []
    total = 0
    for group in sel["groups"]:
        pat = re.compile(group["match"])
        ids = sorted(i for i in full if pat.fullmatch(i))
        if group.get("exclude"):
            ex = re.compile(group["exclude"])
            ids = [i for i in ids if not ex.fullmatch(i)]
        if group.get("limit"):
            step = max(1, len(ids) / group["limit"])
            ids = [ids[int(k * step)] for k in range(min(group["limit"], len(ids)))]
        for aid in ids:
            e = full[aid]
            states = {}
            for st in group["states"]:
                if st not in e["states"]:
                    continue
                ver, jt, j, rest = read_glb(os.path.join(lib, aid, st + ".glb"))
                for img in j.get("images", []):
                    u = img.get("uri", "")
                    if not u.startswith("@tex:"):
                        continue
                    src = u[5:]
                    if src not in tex_names:
                        h = hashlib.sha1(open(src, "rb").read()).hexdigest()[:10]
                        base = os.path.basename(src)
                        nm = base if used_names.get(base, h) == h else f"{os.path.splitext(base)[0]}_{h}{os.path.splitext(base)[1]}"
                        used_names[base] = used_names.get(base, h)
                        if not os.path.exists(os.path.join(out, "textures", nm)):
                            shutil.copyfile(src, os.path.join(out, "textures", nm))
                            total += os.path.getsize(src)
                        tex_names[src] = nm
                    img["uri"] = "textures/" + tex_names[src]
                fn = f"{aid}_{st}.glb"
                write_glb(os.path.join(out, fn), ver, jt, j, rest)
                total += os.path.getsize(os.path.join(out, fn))
                s = e["states"][st]
                states[st] = {"file": fn, "min": s["min"], "max": s["max"], "tris": s["tris"]}
            if "normal" in states:
                result.append({"id": aid, "name": e["name"], "role": group["role"], "states": states})
    json.dump({"assets": result}, open(os.path.join(out, "catalog.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"select: {len(result)} assets, {total / 1e6:.1f} MB -> {out}")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("library", "all"):
        library()
    if cmd in ("select", "all"):
        select()
