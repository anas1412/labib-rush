// Litterbug markers: a small billboard above the head. State 0 = warning (a littered can and a
// red '!', pulsing), state 1 = "catch me" (a green badge with a down chevron and a ring counting
// down the catch window). One shared canvas texture (two cells, painted once) and one tiny
// ShaderMaterial per marker; drawn on top of everything so it stays readable in a crowd.
import {
  CanvasTexture, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, SRGBColorSpace, type Camera, type Object3D, type Texture,
} from 'three';

function paintAtlas(): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S * 2; c.height = S;
  const g = c.getContext('2d')!;
  const badge = (ox: number, fill: string, ring: string) => {
    g.save();
    g.translate(ox + S / 2, S / 2);
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
    g.beginPath(); g.arc(0, 0, 50, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = 7; g.strokeStyle = ring; g.stroke();
    g.restore();
  };
  // --- cell 0: warning — a big upright soda can (dark outline so it reads at ~30 px) + '!'
  badge(0, '#fffaf0', '#e8a317');
  g.save();
  g.translate(46, 64);
  g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = '#1d1d1f';
  g.beginPath(); g.roundRect(-20, -34, 40, 68, 8); g.fillStyle = '#e03a2f'; g.fill(); g.stroke();
  g.fillStyle = '#ffffff'; g.fillRect(-17, -8, 34, 14); // label stripe
  g.fillStyle = '#c9ccd1'; g.fillRect(-17, -31, 34, 7); // lid
  g.restore();
  g.lineWidth = 5; g.strokeStyle = '#1d1d1f'; g.fillStyle = '#e03a2f'; // '!'
  g.beginPath(); g.roundRect(80, 24, 20, 50, 8); g.fill(); g.stroke();
  g.beginPath(); g.arc(90, 92, 11, 0, Math.PI * 2); g.fill(); g.stroke();
  // --- cell 1: catch me — green badge, white chevron pointing down at the person
  badge(S, '#23a55a', '#ffffff');
  g.save();
  g.translate(S + S / 2, S / 2 + 4);
  g.strokeStyle = '#ffffff'; g.lineWidth = 15; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(-24, -14); g.lineTo(0, 12); g.lineTo(24, -14); g.stroke();
  g.beginPath(); g.moveTo(0, -30); g.lineTo(0, 8); g.stroke();
  g.restore();
  return c;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uCell;
uniform float uProgress; // 1 = full ring, 0 = empty
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vec2((vUv.x + uCell) * 0.5, vUv.y));
  vec2 p = vUv - 0.5;
  float r = length(p);
  if (uCell > 0.5) {
    // countdown ring just outside the badge, draining clockwise from the top
    float a = fract(atan(p.x, p.y) / 6.2831853 + 1.0);
    float band = smoothstep(0.415, 0.43, r) * (1.0 - smoothstep(0.475, 0.49, r));
    float on = step(a, uProgress);
    vec3 ring = mix(vec3(1.0, 0.3, 0.2), vec3(1.0, 0.92, 0.3), smoothstep(0.15, 0.5, uProgress));
    c.rgb = mix(c.rgb, ring, band * on);
    c.a = max(c.a, band * (0.35 + 0.65 * on));
  }
  gl_FragColor = vec4(c.rgb, c.a * uOpacity);
  #include <colorspace_fragment>
}`;

export class LitterIcons {
  readonly meshes: Mesh[] = [];
  private readonly tex: Texture;
  private readonly geo = new PlaneGeometry(1, 1);
  private readonly mats: ShaderMaterial[] = [];

  constructor(parent: Object3D, count: number) {
    const t = new CanvasTexture(paintAtlas());
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    this.tex = t;
    for (let i = 0; i < count; i++) {
      const m = new ShaderMaterial({
        uniforms: { map: { value: t }, uCell: { value: 0 }, uProgress: { value: 1 }, uOpacity: { value: 1 } },
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
      });
      const mesh = new Mesh(this.geo, m);
      mesh.name = `litterbug-icon-${i}`;
      mesh.renderOrder = 20;
      mesh.frustumCulled = false;
      mesh.visible = false;
      parent.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(m);
    }
  }

  /** state 0 warning, 1 catch-me; progress = catch window left 0..1; pulse 0..1 scale kick. */
  show(i: number, x: number, y: number, z: number, camera: Camera, state: 0 | 1, progress: number, pulse: number): void {
    const mesh = this.meshes[i], u = this.mats[i].uniforms;
    mesh.visible = true;
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(camera.quaternion);
    // keep at least ~26 px on a 900 px tall screen: grow with distance
    const d = camera.position.distanceTo(mesh.position);
    const s = Math.max(0.6, d * 0.055) * (1 + 0.18 * pulse);
    mesh.scale.set(s, s, s);
    u.uCell.value = state;
    u.uProgress.value = progress;
    u.uOpacity.value = 1;
  }

  hide(i: number): void { this.meshes[i].visible = false; }

  dispose(): void {
    for (const m of this.meshes) m.removeFromParent();
    for (const m of this.mats) m.dispose();
    this.geo.dispose();
    this.tex.dispose();
  }
}
