{
  description = "Template for Holochain app development";

  inputs = {
    p2p-shipyard.url = "github:darksoil-studio/tauri-plugin-holochain/main-0.6.1";
    holonix.url = "github:holochain/holonix/main-0.6";

    nixpkgs.follows = "holonix/nixpkgs";
  };

  outputs = inputs @ { ... }:
    inputs.holonix.inputs.flake-parts.lib.mkFlake { inherit inputs; }
    {
      systems = builtins.attrNames inputs.holonix.devShells;

      perSystem =
        { inputs', pkgs, system, ...}: {
          devShells.default = pkgs.mkShell {
            inputsFrom = [
              inputs'.holonix.devShells.default
              inputs'.p2p-shipyard.devShells.holochainTauriDev
            ];

          };
          devShells.androidDev = pkgs.mkShell {
            inputsFrom = [
              inputs'.p2p-shipyard.devShells.holochainTauriAndroidDev
              inputs'.holonix.devShells.default
            ];
          };
        };
    };
}