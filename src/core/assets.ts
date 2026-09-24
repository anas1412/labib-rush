// Shared asset loading with one progress-tracked LoadingManager and caches.
import {
  LoadingManager, TextureLoader, SRGBColorSpace, RepeatWrapping, LinearMipmapLinearFilter,
  type Texture, type WebGLRenderer, type DataTexture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export interface TextureOptions {
  srgb?: boolean; // true for albedo/basecolor, false for normal/roughness/ao/arm
  repeat?: [number, number];
}

export class Assets {
  readonly manager = new LoadingManager();
  private tex = new TextureLoader(this.manager);
  private gltf: GLTFLoader;
  private hdr = new HDRLoader(this.manager);
  private texCache = new Map<string, Promise<Texture>>();
  private gltfCache = new Map<string, Promise<GLTF>>();
  private maxAniso = 8;
  /** 0..1 over everything requested so far. */
  onProgress: (progress01: number, url: string) => void = () => {};

  constructor(renderer: WebGLRenderer) {
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const draco = new DRACOLoader(this.manager).setDecoderPath('/draco/');
    this.gltf = new GLTFLoader(this.manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
    this.manager.onProgress = (url, loaded, total) => this.onProgress(total ? loaded / total : 1, url);
  }

  /** Cached texture. Same url + different options → clone shares the image. Paths are relative to /public. */
  texture(url: string, opts: TextureOptions = {}): Promise<Texture> {
    let p = this.texCache.get(url);
    if (!p) {
      p = this.tex.loadAsync(url).then((t) => {
        t.anisotropy = this.maxAniso;
        t.minFilter = LinearMipmapLinearFilter;
        return t;
      });
      this.texCache.set(url, p);
    }
    return p.then((base) => {
      const t = opts.repeat ? base.clone() : base;
      if (opts.srgb) t.colorSpace = SRGBColorSpace;
      if (opts.repeat) {
        t.wrapS = t.wrapT = RepeatWrapping;
        t.repeat.set(opts.repeat[0], opts.repeat[1]);
        t.needsUpdate = true;
      }
      return t;
    });
  }

  gltfModel(url: string): Promise<GLTF> {
    let p = this.gltfCache.get(url);
    if (!p) this.gltfCache.set(url, (p = this.gltf.loadAsync(url)));
    return p;
  }

  hdri(url: string): Promise<DataTexture> {
    return this.hdr.loadAsync(url);
  }
}
