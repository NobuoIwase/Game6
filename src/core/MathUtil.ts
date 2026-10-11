// 共通の数学ユーティリティ
// Babylon.js は左手系: +Z が前、+Y が上、+X が右。
// RotationYawPitchRoll(yaw, pitch, roll): yaw+ は +Z→+X、pitch+ は +Z→-Y（下向き）、roll+ は +X→+Y。
import { Quaternion, Vector3 } from "@babylonjs/core";

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** フレームレートに依存しない指数減衰の補間係数 */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** 角度差を -π..π に正規化 */
export function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function yawOf(dir: Vector3) {
  return Math.atan2(dir.x, dir.z);
}

/** +Z を dir に向ける回転 */
export function lookQuat(dir: Vector3, out = new Quaternion(), roll = 0): Quaternion {
  const len = dir.length() || 1;
  const yaw = Math.atan2(dir.x, dir.z);
  const pitch = -Math.asin(clamp(dir.y / len, -1, 1));
  return Quaternion.RotationYawPitchRollToRef(yaw, pitch, roll, out);
}

/** from を to に回す最短回転 */
export function fromToQuat(from: Vector3, to: Vector3, out = new Quaternion()): Quaternion {
  const f = from.normalizeToNew();
  const t = to.normalizeToNew();
  const d = Vector3.Dot(f, t);
  if (d > 0.99999) return out.copyFromFloats(0, 0, 0, 1);
  if (d < -0.99999) {
    let axis = Vector3.Cross(Vector3.Right(), f);
    if (axis.lengthSquared() < 1e-6) axis = Vector3.Cross(Vector3.Up(), f);
    axis.normalize();
    return Quaternion.RotationAxisToRef(axis, Math.PI, out);
  }
  const axis = Vector3.Cross(f, t).normalize();
  return Quaternion.RotationAxisToRef(axis, Math.acos(d), out);
}

/** 点 p と線分 ab の最短距離の2乗 */
export function distPointSegmentSq(p: Vector3, a: Vector3, b: Vector3): number {
  const abx = b.x - a.x,
    aby = b.y - a.y,
    abz = b.z - a.z;
  const apx = p.x - a.x,
    apy = p.y - a.y,
    apz = p.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? (apx * abx + apy * aby + apz * abz) / l2 : 0;
  t = clamp(t, 0, 1);
  const dx = apx - abx * t,
    dy = apy - aby * t,
    dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/** 線分同士の最短距離の2乗（弾とカプセルの判定用） */
export function distSegmentSegmentSq(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3): number {
  const d1 = q1.subtract(p1),
    d2 = q2.subtract(p2),
    r = p1.subtract(p2);
  const a = Vector3.Dot(d1, d1),
    e = Vector3.Dot(d2, d2),
    f = Vector3.Dot(d2, r);
  let s = 0,
    t = 0;
  if (a <= 1e-9 && e <= 1e-9) return r.lengthSquared();
  if (a <= 1e-9) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = Vector3.Dot(d1, r);
    if (e <= 1e-9) {
      s = clamp(-c / a, 0, 1);
    } else {
      const b = Vector3.Dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const c1 = p1.add(d1.scale(s));
  const c2 = p2.add(d2.scale(t));
  return Vector3.DistanceSquared(c1, c2);
}

/** レイと球の交差距離（当たらなければ -1） */
export function raySphere(o: Vector3, d: Vector3, c: Vector3, r: number): number {
  const ox = o.x - c.x,
    oy = o.y - c.y,
    oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? 0 : -1;
}

/** 放物線で目標に届く初速（速さ speed 固定、低い弾道）。届かなければ直線＋上方補正 */
export function ballisticVelocity(from: Vector3, to: Vector3, speed: number, gravity: number): Vector3 {
  const d = to.subtract(from);
  const h = Math.hypot(d.x, d.z);
  const g = -gravity;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * h * h + 2 * d.y * v2);
  const dirH = new Vector3(d.x, 0, d.z).normalize();
  if (disc < 0 || h < 0.01) {
    const t = d.length() / speed;
    return d.normalize().scale(speed).add(new Vector3(0, (g * t) / 2, 0));
  }
  const ang = Math.atan2(v2 - Math.sqrt(disc), g * h);
  return dirH.scale(Math.cos(ang) * speed).add(new Vector3(0, Math.sin(ang) * speed, 0));
}
