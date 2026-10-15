#!/usr/bin/env python3
"""
外部アセット（GLB）をゲームで読み込める配置に変換する。

TexturedExisting1240 などのパックは models/<id>/<state>.glb から ../../textures/x.png を
参照しているが、Babylon.js の glTF ローダーは安全のため「..」を含む URI を拒否する。
そこで次の平らな配置にコピーし、GLB 内の画像 URI を書き換える:

    <out>/<id>_<state>.glb   （uri: "textures/x.png"）
    <out>/textures/x.png

使い方: python3 scripts/pack_glb.py <パックのルート> <出力先> <id[:state,state]> ...
       id の代わりに @ファイル で 1 行 1 件のリストを渡せる。state 省略時は normal,lod1,lod2,wreck
"""
import json, os, shutil, struct, sys

def rewrite(src, dst, tex_src_dir, tex_out_dir):
    b = open(src, "rb").read()
    magic, ver, total = struct.unpack("<III", b[:12])
    assert magic == 0x46546C67, src
    jlen, jtype = struct.unpack("<II", b[12:20])
    j = json.loads(b[20:20 + jlen])
    rest = b[20 + jlen:]
    for img in j.get("images", []):
        uri = img.get("uri")
        if not uri or uri.startswith("data:"):
            continue
        name = os.path.basename(uri)
        s = os.path.normpath(os.path.join(os.path.dirname(src), uri))
        if not os.path.exists(os.path.join(tex_out_dir, name)):
            shutil.copyfile(s, os.path.join(tex_out_dir, name))
        img["uri"] = "textures/" + name
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    out = struct.pack("<III", magic, ver, 12 + 8 + len(js) + len(rest)) + struct.pack("<II", len(js), jtype) + js + rest
    open(dst, "wb").write(out)

def main():
    root, out = sys.argv[1], sys.argv[2]
    items = []
    for a in sys.argv[3:]:
        if a.startswith("@"):
            items += [l.strip() for l in open(a[1:]) if l.strip()]
        else:
            items.append(a)
    tex_out = os.path.join(out, "textures")
    os.makedirs(tex_out, exist_ok=True)
    n = 0
    for it in items:
        aid, _, states = it.partition(":")
        for st in (states.split(",") if states else ["normal", "lod1", "lod2", "wreck"]):
            src = os.path.join(root, "models", aid, st + ".glb")
            if not os.path.exists(src):
                print("missing", src)
                continue
            rewrite(src, os.path.join(out, f"{aid}_{st}.glb"), None, tex_out)
            n += 1
    print(f"{n} files -> {out}")

if __name__ == "__main__":
    main()
