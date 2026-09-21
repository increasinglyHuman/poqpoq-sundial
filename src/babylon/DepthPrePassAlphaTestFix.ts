import type { Material } from "@babylonjs/core/Materials/material";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";

// Babylon 9.17.1 bug, StandardMaterial only (GLSL and WGSL): with
// `transparencyMode = MATERIAL_ALPHATEST` the material defines
// ALPHATEST_AFTERALLALPHACOMPUTATIONS, which moves the alpha test to the end
// of the shader — but the `needDepthPrePass` variant (DEPTHPREPASS) returns
// early, at `#include<depthPrePass>`, before that test ever runs. The prepass
// therefore writes the depth of whole alpha-tested quads, and the colour pass
// then discards their transparent texels, punching holes that hide whatever
// lies behind them. PBR is unaffected (its alpha test runs inside the albedo
// block, before the prepass exit).
//
// Fix: alpha-test at CUSTOM_FRAGMENT_UPDATE_ALPHA, which sits after the
// diffuse alpha is applied and before the prepass exit, in the prepass
// variant only. The colour pass is untouched.

/** Makes `needDepthPrePass` honour alpha testing on a StandardMaterial. */
export class DepthPrePassAlphaTestFix extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "DepthPrePassAlphaTestFix", 50, {});
    this._enable(true);
  }

  override getClassName(): string {
    return "DepthPrePassAlphaTestFix";
  }

  override isCompatible(): boolean {
    return true;
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== "fragment") return null;
    const cutoff = shaderLanguage === ShaderLanguage.WGSL ? "uniforms.alphaCutOff" : "alphaCutOff";
    return {
      CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#if defined(DEPTHPREPASS) && defined(ALPHATEST) && defined(ALPHATEST_AFTERALLALPHACOMPUTATIONS)
if (alpha < ${cutoff}) { discard; }
#endif
`,
    };
  }
}
