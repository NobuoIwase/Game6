// ============================================================================
// 入力（キーボード・マウス・タッチ）を1つの状態にまとめる。
// ゲーム側は毎フレーム Input の値を読むだけで、デバイスの違いを意識しない。
// ============================================================================

export class Input {
  moveX = 0; // 右が +
  moveY = 0; // 前が +
  lookDX = 0; // 1フレーム分の視点移動量（ピクセル相当）
  lookDY = 0;
  fire = false;
  zoom = false;

  // 1回だけ反応する操作（consume で取り出す）
  private edges = new Set<string>();
  private keys = new Set<string>();
  private mouseFire = false;
  private touchFire = false;
  private touchZoom = false;
  private stick = { x: 0, y: 0 };
  readonly touchMode: boolean;
  mouseSensitivity = 0.0022;
  touchSensitivity = 0.0055;
  enabled = false;

  constructor(private canvas: HTMLCanvasElement, touch: boolean) {
    this.touchMode = touch;
    this.bindKeyboardMouse();
    if (touch) this.bindTouch();
  }

  consume(name: string): boolean {
    if (this.edges.has(name)) {
      this.edges.delete(name);
      return true;
    }
    return false;
  }

  press(name: string) {
    if (this.enabled) this.edges.add(name);
  }

  /** 毎フレーム最後に呼ぶ */
  endFrame() {
    this.lookDX = 0;
    this.lookDY = 0;
  }

  update() {
    let x = 0,
      y = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) y += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) y -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) x += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) x -= 1;
    x += this.stick.x;
    y += this.stick.y;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.moveX = x;
    this.moveY = y;
    this.fire = this.enabled && (this.mouseFire || this.touchFire);
    this.zoom = this.enabled && (this.zoomHeld || this.touchZoom);
  }

  private zoomHeld = false;

  get pointerLocked() {
    return document.pointerLockElement === this.canvas;
  }

  requestLock() {
    if (this.touchMode) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* 失敗しても無視（iframe 内など） */
    }
  }

  private bindKeyboardMouse() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      switch (e.code) {
        case "KeyR":
          this.press("reload");
          break;
        case "KeyQ":
        case "KeyE":
        case "Tab":
          this.press("switch");
          e.preventDefault();
          break;
        case "Digit1":
          this.press("weapon0");
          break;
        case "Digit2":
          this.press("weapon1");
          break;
        case "Space":
          this.press("jump");
          e.preventDefault();
          break;
        case "ShiftLeft":
        case "ShiftRight":
        case "KeyC":
          this.press("roll");
          break;
        case "Escape":
        case "KeyP":
          this.press("pause");
          break;
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.mouseFire = false;
      this.zoomHeld = false;
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (this.touchMode) return;
      if (!this.pointerLocked) {
        if (this.enabled) this.requestLock();
        return;
      }
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.zoomHeld = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.zoomHeld = false;
    });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.lookDX += e.movementX * this.mouseSensitivity;
      this.lookDY += e.movementY * this.mouseSensitivity;
    });
    window.addEventListener(
      "wheel",
      (e) => {
        if (this.pointerLocked && Math.abs(e.deltaY) > 2) this.press("switch");
      },
      { passive: true },
    );
    document.addEventListener("pointerlockchange", () => {
      if (!this.pointerLocked) {
        this.mouseFire = false;
        this.zoomHeld = false;
      }
    });
  }

  private bindTouch() {
    const stickZone = document.getElementById("stickZone")!;
    const base = document.getElementById("stickBase")!;
    const knob = document.getElementById("stickKnob")!;
    const lookZone = document.getElementById("lookZone")!;
    let stickId = -1;
    let cx = 0,
      cy = 0;
    const R = 55;
    stickZone.addEventListener("pointerdown", (e) => {
      stickId = e.pointerId;
      stickZone.setPointerCapture(e.pointerId);
      const r = stickZone.getBoundingClientRect();
      cx = e.clientX;
      cy = e.clientY;
      base.style.left = `${cx - r.left - 65}px`;
      base.style.top = `${cy - r.top - 65}px`;
      base.style.bottom = "auto";
    });
    stickZone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== stickId) return;
      let dx = e.clientX - cx,
        dy = e.clientY - cy;
      const l = Math.hypot(dx, dy);
      if (l > R) {
        dx = (dx / l) * R;
        dy = (dy / l) * R;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.stick.x = dx / R;
      this.stick.y = -dy / R;
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      stickId = -1;
      this.stick.x = this.stick.y = 0;
      knob.style.transform = "";
    };
    stickZone.addEventListener("pointerup", endStick);
    stickZone.addEventListener("pointercancel", endStick);

    // 視点ドラッグ（射撃ボタンを押したままドラッグでも視点移動できる）
    const lookDrag = (el: HTMLElement, onDown?: () => void, onUp?: () => void) => {
      let id = -1,
        lx = 0,
        ly = 0;
      el.addEventListener("pointerdown", (e) => {
        id = e.pointerId;
        el.setPointerCapture(e.pointerId);
        lx = e.clientX;
        ly = e.clientY;
        onDown?.();
        e.preventDefault();
      });
      el.addEventListener("pointermove", (e) => {
        if (e.pointerId !== id) return;
        this.lookDX += (e.clientX - lx) * this.touchSensitivity;
        this.lookDY += (e.clientY - ly) * this.touchSensitivity;
        lx = e.clientX;
        ly = e.clientY;
      });
      const up = (e: PointerEvent) => {
        if (e.pointerId !== id) return;
        id = -1;
        onUp?.();
      };
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    };
    lookDrag(lookZone);
    const fireBtn = document.getElementById("tFire")!;
    lookDrag(
      fireBtn,
      () => {
        this.touchFire = true;
        fireBtn.classList.add("active");
      },
      () => {
        this.touchFire = false;
        fireBtn.classList.remove("active");
      },
    );
    const tap = (id: string, fn: () => void) => {
      const el = document.getElementById(id)!;
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        fn();
      });
    };
    const zoomBtn = document.getElementById("tZoom")!;
    tap("tZoom", () => {
      this.touchZoom = !this.touchZoom;
      zoomBtn.classList.toggle("active", this.touchZoom);
    });
    tap("tReload", () => this.press("reload"));
    tap("tSwitch", () => this.press("switch"));
    tap("tJump", () => this.press("jump"));
    tap("tRoll", () => this.press("roll"));
    tap("tPause", () => this.press("pause"));
  }

  reset() {
    this.edges.clear();
    this.mouseFire = this.touchFire = false;
    this.zoomHeld = false;
    this.lookDX = this.lookDY = 0;
  }
}
